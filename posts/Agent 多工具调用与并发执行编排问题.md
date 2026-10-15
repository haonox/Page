---
id: tool-orchestration
date: 2026-09-17
category: agent
title: Agent 多工具编排：从并行调用到可靠执行
---

# Agent 多工具编排：从并行调用到可靠执行

模型在同一轮返回了两个调用：

```text
update_account_balance(account_123, -100)
close_account(account_123)
```

从参数看，第二个调用不依赖第一个调用的返回值，似乎可以并发。但它们都在修改同一个账户：如果关户先完成，余额更新可能失败；如果两者交错执行，最终状态甚至可能取决于时序。

这个例子揭示了多工具 Agent 的核心问题：

> **模型能同时提出多个调用，不等于运行时应该同时执行它们。**

生产系统需要一个 Tool Orchestrator，把模型产生的不确定调用请求，转换成受依赖、权限、资源冲突、容量与失败语义共同约束的执行计划。

## 先把“多工具”拆成四个问题

“Agent 支持多工具”可能指四件完全不同的事：

1. **多工具暴露**：一次请求中，模型可从多个工具中选择；
2. **单轮多调用**：模型在一次响应中生成多个 tool call；
3. **执行并发**：运行时真正同时调用多个工具；
4. **多步编排**：运行时根据依赖与观察，分多轮完成一个工具图。

OpenAI Function Calling 协议中的 `parallel_tool_calls` 控制的是第二层：模型是否可在一轮中产生多个 function call。对自定义工具来说，第三、第四层始终由应用侧决定。

这个区分能避免一个危险的实现：看到响应中有三个 call，就直接对它们调用 `asyncio.gather()`。

## 编排器更像一个小型编译器

工具编排可以被理解为一条编译管线：

```text
Model Tool Calls
        │ parse
        ▼
Normalized Tasks
        │ validate + authorize
        ▼
Allowed Task Set
        │ dependency + conflict analysis
        ▼
Execution Plan / DAG
        │ schedule + limit + lock
        ▼
Attempts
        │ normalize + persist
        ▼
Tool Results
        │ aggregate
        ▼
Model Observation
```

每个阶段都只承担一类语义：

- **Parser** 将供应商协议转换为系统内部任务；
- **Validator** 检查参数、工具版本和业务前置条件；
- **Policy Engine** 判断是否允许、是否需要审批；
- **Planner** 识别数据依赖与资源冲突；
- **Scheduler** 决定何时运行、使用哪个容量池；
- **Executor** 负责超时、取消、重试与幂等；
- **Aggregator** 用稳定、可预测的形式将结果返回模型。

把这些职责塞进一个“调用函数名”的 `if/elif` 分发器，可以很快做出 demo，但无法解释生产环境中的并发、重试和部分成功。

## 工具注册表要表达执行语义

提供给模型的工具定义，通常只包含名称、描述和参数 Schema。编排器还需要一份不对模型公开的工程元数据：

```yaml
name: refund_order
version: 3
read_only: false
side_effect: financial
idempotency: key_required
risk: high
approval: required
timeout_ms: 10000
max_attempts: 1
resource_reads:
  - "order:{order_id}"
resource_writes:
  - "order:{order_id}"
  - "payment:{payment_id}"
required_scopes:
  - "orders.refund"
capacity_pool: "payments"
result_limit_bytes: 10240
```

这些字段不是文档备注，而是编排计算的输入。例如：

- `read_only` 和 `resource_writes` 影响并发决策；
- `idempotency` 和 `max_attempts` 影响重试；
- `risk` 和 `approval` 影响是否可进入执行队列；
- `capacity_pool` 防止某类慢工具拖垮整个系统；
- `result_limit_bytes` 防止大结果无界地进入模型上下文。

对副作用不明、幂等性未知的工具，应采用保守默认：按写操作处理、不自动重试、不与共享资源操作并发。

## 从 Tool Call 到内部任务

模型调用进入编排器后，应先转换为稳定的内部对象：

```python
@dataclass(frozen=True)
class ToolTask:
    run_id: str
    call_id: str
    tool_name: str
    tool_version: int
    arguments: dict
    depends_on: tuple[str, ...]
    read_keys: tuple[str, ...]
    write_keys: tuple[str, ...]
    idempotency_key: str | None
    deadline: datetime
    risk: str
```

其中有三类 ID 需要严格区分：

| ID | 表达什么 | 是否在重试时变化 |
| --- | --- | --- |
| `run_id` | 一次完整 Agent 运行 | 否 |
| `call_id` | 模型提出的一次工具调用 | 否 |
| `attempt_id` | 对该调用的一次实际执行尝试 | 是 |

```text
run_17
  └─ call_8
       ├─ attempt_1: connection timeout
       └─ attempt_2: succeeded
```

幂等键应绑定逻辑调用，因此重试时保持不变；`attempt_id` 则用来记录每次网络或进程级尝试。

## 并发正确性需要两张图

只看参数依赖无法安全判断并发。编排器至少要同时考虑两种关系。

### 数据依赖图

后一个任务需要前一个任务的结果：

```text
search_customer(email)
        │ customer_id
        ▼
list_orders(customer_id)
        │ order_id
        ▼
refund_order(order_id)
```

这些任务天然形成 DAG。只有当全部前置节点完成，下游节点才会进入 ready 集合。

### 资源冲突图

两个任务的参数可以完全独立，却会读写同一个业务对象：

```text
cancel_order(order_123)
update_shipping_address(order_123)
```

对两个任务 `A` 和 `B`，一个保守的冲突条件是：

```text
A.write_keys ∩ (B.read_keys ∪ B.write_keys) ≠ ∅
OR
B.write_keys ∩ (A.read_keys ∪ A.write_keys) ≠ ∅
```

只读任务之间通常可以并发；任何一方会写共享资源时，默认应串行或使用业务支持的并发控制。

## Resource Key 只是第一层锁

资源模板可以将工具参数转换为业务键：

```yaml
resource_writes:
  - "order:{order_id}"
```

实例化后：

```text
cancel_order(order_id=1001) → order:1001
refund_order(order_id=1001) → order:1001
refund_order(order_id=1002) → order:1002
```

前两个调用进入同一个串行域，第三个可以并发。这比给整个 `refund_order` 工具加全局锁精细得多。

但 resource key 不能取代数据库事务、唯一约束和乐观锁。原因包括：

- 其他服务可能不经过 Agent 编排器就修改相同资源；
- 多个编排器实例需要共享一致的锁语义；
- 业务不变量必须由最终数据持有者守住。

编排层的资源锁防止明显冲突进入执行，数据层约束则保护最终正确性。重要写操作通常需要两者。

## 一个保守的并发决策矩阵

| 组合 | 默认策略 | 仍需检查 |
| --- | --- | --- |
| 读 A + 读 B | 并发 | 外部限流、一致性要求 |
| 读 A + 读 A | 并发 | 是否可合并为一次请求 |
| 读 A + 写 A | 串行 | 读是否要看写前还是写后状态 |
| 写 A + 写 A | 串行 | 业务顺序和版本条件 |
| 写 A + 写 B | 满足策略时并发 | 跨资源不变量、下游容量 |
| 付款、删除、发送 | 审批后开始 | 幂等、金额/对象绑定、审计 |
| 副作用未知 | 按写操作串行 | 先补齐工具元数据 |

这个矩阵是安全默认，不是数学真理。例如两个写操作虽然作用于不同订单，但都可能消耗同一用户的信用额度。真正的资源集要由业务不变量推导，不能只看工具名和表面参数。

## 调度的目标是有界并发，不是最大并发

可执行任务需要同时满足：

```text
前置依赖已完成
AND 策略与审批已通过
AND 资源锁可获得
AND 容量配额可用
AND 未超过 deadline
AND 运行未被取消
```

一个简化调度循环可以写成：

```python
async def schedule(plan, runtime):
    while not plan.is_terminal():
        ready = plan.ready_tasks()

        for task in ready:
            if not runtime.policy_allows(task):
                plan.reject(task, reason="policy_denied")
                continue

            if runtime.deadline_exceeded(task):
                plan.expire(task)
                continue

            if not runtime.capacity_available(task.capacity_pool):
                continue

            if not runtime.resources_available(task):
                continue

            runtime.start(task)

        completion = await runtime.next_completion()
        plan.apply(completion)
        runtime.release(completion.task)
```

生产环境中通常要同时限制：

- 单次 run 的并发数和 fan-out；
- 单用户、租户和权限域的并发数；
- 单工具和单下游服务的速率；
- 单资源的写并发；
- 整个执行集群的总容量。

不同工具类型应使用独立容量池：

```text
search pool       → 高并发、低风险
file-processing   → CPU / IO 隔离
remote MCP        → 按 server 限流
payment           → 低并发、强审批
```

这种舱壁隔离可以防止一类慢或故障工具占满所有 worker。

### 限流还需要公平性

只有全局 semaphore 时，一个大 fan-out 任务可能长时间占满队列，让其他用户的短任务饥饿。调度器还应考虑：

- 按租户的加权公平队列；
- 交互请求与批处理任务的优先级隔离；
- 长时间等待任务的优先级提升；
- 单个 run 最多占用的容量份额。

稳定性不只是“系统不崩溃”，还包括某个用户不能让所有其他用户失去服务。

## 任务状态不能只有成功和失败

```text
PROPOSED
   │ validate
   ▼
VALIDATED ──▶ WAITING_APPROVAL
   │                │ approved
   └──────────────┘
   ▼
READY → QUEUED → RUNNING
                     ├→ SUCCEEDED
                     ├→ FAILED
                     ├→ TIMED_OUT
                     ├→ CANCELLED
                     └→ UNKNOWN
```

`UNKNOWN` 是最重要、也最容易被省略的状态。

假设退款请求已发送，但客户端在收到响应前超时：

```text
没有收到成功响应
≠
退款一定没有发生
```

如果把它标记为 `FAILED` 并直接重试，可能造成重复副作用。正确路径是：

1. 标记为 `UNKNOWN`；
2. 使用原幂等键查询业务结果；
3. 有 reconciliation API 时主动核对；
4. 仍无法判定时进入人工处理。

通信层超时是一个观察，不是业务结果。

## 超时、Deadline 与取消是三件事

| 概念 | 它限制什么 |
| --- | --- |
| Attempt timeout | 一次 HTTP、RPC 或本地执行最多等待多久 |
| Task deadline | 排队、重试和执行加起来最晚何时完成 |
| Run budget | 整个 Agent 在时间、工具次数和成本上的上限 |

即使某次请求还有重试次数，只要 task deadline 已经耗尽，就不应再启动新 attempt。

取消则需要沿依赖图传播：

```text
用户取消 run
→ 取消未启动任务
→ 向正在执行的任务传递取消信号
→ 阻止下游依赖节点
→ 持续跟踪无法立即取消的外部 job
```

“应用不再等待”不等于“外部任务已经停止”。对无法取消的 job，应标记为 `detached` 或 `cancellation_pending`，通过回调或轮询追踪最终状态。

## 重试的目标不是 Exactly Once

在跨进程、跨网络执行中，编排器很难证明一个操作“刚好执行一次”。更现实的目标是：

> **调用可以被投递多次，但通过幂等键、条件写入或状态核对，让业务效果只生效一次。**

推荐策略：

| 工具类型 | 重试策略 |
| --- | --- |
| 只读、幂等查询 | 在 deadline 内指数退避并加入抖动 |
| 带幂等键的写入 | 使用原键查询或重试 |
| 可核对的非幂等写入 | 先查询外部状态，再决定是否补做 |
| 不可核对的非幂等写入 | 禁止自动重试 |
| 参数错误或权限拒绝 | 不做运输层重试 |
| 限流 | 遵守 Retry-After 或重新排队 |

重试时：

```text
call_id          不变
idempotency_key  不变
attempt_id       递增或重新生成
```

随机抖动用于避免大量失败任务在同一时刻重试，形成新的流量峰值。

## 部分成功是正常路径

并发批次中，“全部成功或全部失败”往往不成立：

```text
create_order       → succeeded
reserve_inventory  → succeeded
charge_payment     → failed
send_notification  → not_started
```

编排器需要根据业务语义选择：

1. **允许部分成功**：例如同时查询多个独立数据源；
2. **失败后停止下游**：依赖链不再具备执行条件；
3. **执行补偿**：已成功的副作用需要显式撤销或对冲。

例如：

```text
reserve_inventory  ↔ release_inventory
create_order       ↔ cancel_order
charge_payment     ↔ refund_payment
```

补偿不是数据库 rollback。它是一个新的业务动作，可能失败、需要审批，也必须拥有自己的幂等键和状态。因此补偿任务应进入正式执行图，而不是藏在一个 `except` 块里。

## 三种结果汇聚模式

### Barrier：等待同批任务收敛

```text
A ─┐
B ─┼─ 全部完成或到达 deadline → LLM
C ─┘
```

这是短时间、独立查询的良好默认。它调用模型次数少，结果集合稳定，便于复现。代价是整批延迟受最慢任务影响。

### Progressive：用部分结果继续决策

```text
A 完成 → LLM
B 完成 → LLM
C 完成 → LLM
```

它适合长时搜索、流式分析或早期结果可能让后续任务失去必要性的场景。代价是更多模型调用，且并发完成顺序可能影响决策轨迹。

### Async Job：持久化等待长任务

```json
{
  "status": "accepted",
  "job_id": "job_789"
}
```

对分钟或小时级任务，运行时不应占用一个内存协程等待。它应持久化 waiting 状态，通过 webhook、消息或有界轮询在 job 完成后恢复 Agent。

## 结果顺序必须稳定

并发完成顺序是不确定的：

```text
run 1: A → B → C
run 2: C → A → B
run 3: B → C → A
```

如果 Aggregator 按到达顺序拼接文本，模型每次看到的上下文都可能不同。更可控的策略是：

- 用 `call_id` 关联调用与结果；
- 按原始调用顺序或明确的稳定键输出；
- 对成功、失败、超时、取消和未知使用同一结果封装；
- 分开保存原始输出和提供给模型的规范化输出；
- 对超大结果使用外部存储、分页、筛选或可追溯摘要。

统一结果可以是：

```json
{
  "call_id": "call_8",
  "tool": "get_inventory",
  "status": "succeeded",
  "attempts": 1,
  "started_at": "...",
  "finished_at": "...",
  "data": {"available": 20},
  "error": null,
  "truncated": false
}
```

稳定排序无法让模型完全确定，但它可以消除一个没有业务意义的随机性来源。

## 持久化是长流程的正确性条件

如果执行状态只存在内存中，进程重启后系统无法回答：

- 哪些工具已经成功？
- 哪些调用仍在外部系统执行？
- 哪些任务可以安全重试？
- 哪些下游节点已经失去前置条件？
- 用户已经审批了哪组精确参数？

至少应持久化：

```text
run 状态与总预算
执行图与依赖
call 状态
attempt 记录
幂等键
资源键与锁租约
审批记录
原始与规范化结果引用
补偿任务状态
```

恢复时使用分类策略：

| 恢复时看到的状态 | 处置 |
| --- | --- |
| 已成功 | 复用持久化结果，不重新执行 |
| 尚未启动 | 重新进入调度队列 |
| 幂等只读任务中断 | 在 deadline 内重试 |
| 带幂等键的写入中断 | 用原键查询或重试 |
| 非幂等写入中断 | 标记 `UNKNOWN`，先核对业务状态 |
| 等待审批 | 恢复等待，并验证审批是否过期 |

对跨越分钟、小时或人工审批的流程，持久化不是性能优化，而是不重复副作用的基础。

## 审批必须绑定具体操作

“允许 Agent 继续”不是有效的高风险审批。一个可审计的批准应绑定：

```text
tool_name
tool_version
normalized_arguments
target_resource
actor / tenant
risk summary
expires_at
```

例如：

```text
允许 refund_order
对 order_123
退款 299 CNY
原路返回 payment_456
本次批准 10 分钟内有效
```

如果金额、订单或收款路径发生变化，原审批必须失效。否则审批的只是一个模糊意图，而不是将要发生的真实副作用。

## MCP 解决连接，不建立信任

MCP 可以统一工具发现和调用协议，但远程 MCP Server 的工具描述、参数要求和返回结果仍是外部输入。

编排器仍需要：

- 对 server 和 tool 建立白名单；
- 将凭据限定在最小必要作用域；
- 不把工具返回中的文本当作高优先级指令；
- 在本地重新校验高风险参数和结果；
- 按 server 隔离容量、超时和故障；
- 防止动态新增工具绕过既有审批政策。

协议相容不等于安全可执行。

## 可观测性要能解释调度决策

链路跟踪的层次应与执行模型一致：

```text
run_id
  └─ call_id
       ├─ attempt_id_1
       └─ attempt_id_2
```

常用指标包括：

- 每次 run 的 call 数、fan-out 和关键路径长度；
- 队列等待、锁等待与真实执行时间；
- 每个工具的成功、失败、超时、取消和 `UNKNOWN` 比例；
- 重试次数、幂等命中和核对结果；
- 限流、熔断、锁冲突和公平调度等待；
- 部分成功、补偿发起与补偿失败；
- 取消后仍在外部运行的 detached job；
- 单次 run 的时间、token、工具和货币成本。

仅记录“调用失败”还不够。系统应能回答：

- 为什么两个调用被并发？
- 为什么一个调用等待资源锁？
- 为什么某次超时可重试，另一次却进入 `UNKNOWN`？
- 为什么下游节点没有启动？
- 为什么触发了审批或补偿？

日志和 Trace 应对个人信息、付款数据和企业机密做脱敏。可观测不能成为新的数据泄漏面。

## 三种落地形态

### 进程内有界并发

适合秒级、低风险、以只读 I/O 为主的调用。实现简单，但进程崩溃时未完成任务通常无法自动恢复。

### 消息队列与独立 Worker

适合高吞吐、工具需要独立扩缩容或资源模型差异很大的场景。系统必须显式处理重复消息、死信队列、取消传播和结果一致性。

### 持久化工作流引擎

适合跨分钟或跨天、包含定时、审批、补偿和强审计的流程。工作流引擎保存时间与状态，LLM 只负责需要语言理解和非结构化判断的节点。

| 场景 | 起点 |
| --- | --- |
| 短时间、独立、低风险查询 | 进程内有界并发 |
| 高吞吐、多容量池、需水平扩容 | 队列 + Worker |
| 长时间、审批、补偿、强恢复 | 持久化工作流引擎 |

不要为了“架构完整”一开始就引入分布式工作流引擎；也不要在任务已经跨越人工审批和数小时时，仍使用一个内存 `gather()` 假装它可恢复。

## 分阶段建设路径

### 第一阶段：安全地执行一批独立工具

- 建立统一工具注册表；
- 明确只读、写入和高风险工具；
- 实现参数校验、权限检查和审批；
- 用 `call_id` 关联结果；
- 加入 run、工具和全局并发上限；
- 使用 Barrier 作为默认汇聚方式。

### 第二阶段：保证重试、冲突与恢复正确

- 引入 resource read/write keys；
- 建立 call 与 attempt 分层；
- 按工具类型定义幂等和重试策略；
- 区分 timeout、failed 与 unknown；
- 持久化 run、call、attempt 和审批；
- 实现取消传播与故障恢复。

### 第三阶段：支持长时间业务图

- 使用显式 DAG 表达依赖；
- 支持 async job 与持久化等待；
- 将补偿操作作为正式任务；
- 建立租户公平调度和多容量池；
- 完善 Trace、指标、核对和人工处理工作台。

建设顺序应先解决正确性，再扩展自治性。如果系统还无法区分“失败”和“结果未知”，就不应急于让模型生成更大的并行计划。

## 上线前检查清单

### 工具契约

- 是否为每个工具定义了只读/写入、副作用、幂等和风险等级？
- 未知工具是否默认采取保守策略？
- 工具升级后，旧运行是否仍能找到对应版本？

### 并发与依赖

- 是否同时检查数据依赖和资源冲突？
- 资源键是否来自业务不变量，而不只是工具名？
- 数据层是否仍然有事务、版本或唯一约束？

### 执行与恢复

- 是否区分 `call_id`、`attempt_id` 和幂等键？
- 超时后是否会错误地将写操作标记为未执行？
- 进程重启后是否可以在不重复副作用的情况下恢复？
- 取消是否会向队列、worker 和外部 job 传播？

### 结果与观测

- 汇聚结果是否使用稳定顺序？
- 原始结果和模型可见结果是否分开保存？
- 系统是否能解释为什么并发、串行、重试、拒绝或补偿？
- 日志和 Trace 是否已脱敏？

## 结语

`parallel_tool_calls` 解决的是模型能否在一轮中提出多个工具调用。Tool Orchestrator 解决的则是另一个问题：这些调用能否在真实世界中被安全、有界、可恢复地执行。

这套职责边界可以浓缩成四句话：

```text
模型决定建议调用什么。
策略层决定能不能调用。
调度器决定何时、以何种并发度调用。
业务系统保证调用如何正确生效。
```

成熟的多工具 Agent 不会把“更多并发”当作目标。它会把每一批 Tool Call 编译为一个可解释的执行计划，并在失败、重启、冲突和部分成功中仍然守住业务正确性。

参考：[OpenAI Function Calling 官方文档](https://developers.openai.com/api/docs/guides/function-calling)
