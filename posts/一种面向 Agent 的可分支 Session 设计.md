---
id: branchable-session
date: 2026-09-11
category: agent
title: Agent 的可分支 Session：把对话历史建模为树
---

# Agent 的可分支 Session：把对话历史建模为树

> 当 Agent 开始调用工具、修改环境、压缩上下文并从中间节点重新探索时，`messages[]` 就不再是一个足够完整的 Session 模型。更稳健的设计是：用一棵只追加的历史树保存“发生过什么”，再从其中投影出模型当下需要看到的上下文。

## 从一次“回到过去”开始

假设 Agent 已经沿着一条路线执行了四步：

```text
A → B → C → D
```

在 `D` 处，用户发现方向不对，希望回到 `B` 换一个思路。线性会话通常只有两种做法：

- 删掉 `C` 和 `D`，直接改写过去；
- 复制整个会话，再在副本中继续。

前者损害可追溯性，后者则制造大量重复。真正发生的事情更简单：同一段过去产生了两种未来。

```text
        C → D
       /
A → B
       \
        E → F
```

这就是可分支 Session 要表达的事实。它不是为聊天记录添加一个“复制”按钮，而是重新定义 Session：

> **Session 是 Agent 的轨迹历史，而不只是下一次请求要发给模型的消息数组。**

## 先分清四个概念

可分支 Session 之所以容易设计混乱，往往是因为实现把几个不同层次的概念都叫作“history”。

| 概念 | 它回答的问题 | 典型形态 |
| --- | --- | --- |
| 持久历史 | 真实发生过什么？ | 只追加的节点和事件 |
| 活动分支 | Agent 正在哪个未来上继续？ | 从根到当前 head 的路径 |
| 模型上下文 | 下一次推理应该看到什么？ | 经过筛选、压缩和协议修复的消息 |
| 外部世界 | 文件、数据库和远程服务现在是什么状态？ | 独立于会话的现实环境 |

这四者的关系可以写成：

```text
Persistent History
        │ select head
        ▼
   Active Branch
        │ project + compact
        ▼
   Model Context
        │ reason + act
        ▼
   Tool / World
```

最重要的不是箭头，而是边界：

```text
History ≠ Context
Conversation State ≠ World State
```

后面的所有设计都从这两个不等式推出。

## 历史树的最小数据模型

一棵可回溯的历史树，每个节点最少需要：

```python
@dataclass(frozen=True)
class HistoryNode:
    id: str
    session_id: str
    parent_id: str | None
    kind: str
    payload: dict
    created_at: datetime
```

`parent_id` 定义节点在逻辑树中的位置。从任意 head 沿 `parent_id` 回溯到根，再反转顺序，就得到一条分支的完整路径。

```python
def path_to_root(store, head_id: str) -> list[HistoryNode]:
    path = []
    node = store.get(head_id)

    while node is not None:
        path.append(node)
        node = store.get(node.parent_id) if node.parent_id else None

    return list(reversed(path))
```

但只有节点还不够。系统还需要知道“现在从哪里继续”。为此可以引入类似 Git branch 的引用：

```python
@dataclass(frozen=True)
class BranchRef:
    name: str
    head_id: str
    version: int
```

节点保存历史，`BranchRef` 指向某条分支当前的 head。切换分支只是选择另一个 ref；从旧节点开始探索，则是创建一个指向该节点的新 ref。两种操作都不需要复制旧节点。

### 逻辑上是树，物理上可以是日志

“历史树”和“append-only event log”并不冲突：

- 逻辑结构由节点的 `parent_id` 构成；
- 物理存储可以是 JSONL、SQLite 或数据库中只追加的事件表；
- `node_appended`、`branch_created` 和 `branch_head_moved` 都可以作为独立记录持久化；
- 为了读取性能，可以维护可重建的 `branches` 物化视图。

这个区分能避免一个常见混乱：“只追加”不等于内存中永远不能有一个最新 head；它只要求这个 head 能由持久事件确定性地重建。

## 五个必须成立的系统不变量

一个 Session 系统是否可靠，比“用了树还是数组”更关键的是它能否守住明确的不变量。

### 1. 已确认的历史不原地改写

更正、总结和中断都应形成新节点。否则系统无法回答：“某次工具调用当时究竟发生了什么？”

### 2. 任意活动分支都能回溯到唯一根节点

不允许孤儿节点、断裂的 parent 引用或跨 Session 的父子关系。如果未来引入多父节点来表达 merge，数据结构就从树升级为 DAG，投影规则也必须重新定义，不应偷偷混入当前模型。

### 3. 模型上下文始终来自显式投影

存储层不直接拼模型请求。一次调用使用了哪些节点、哪个 checkpoint 和哪个投影版本，都应该可以追溯。

### 4. 对话分支不隐式回滚外部世界

移动 head 不得偷偷删文件、撤销邮件或回退数据库。需要环境隔离时，应使用 Git worktree、文件系统快照、容器、事务或业务补偿，并将对应的 environment id 记录在轨迹中。

### 5. 不明的工具副作用绝不自动重放

系统崩溃后，“没看到 tool result”不能推出“工具没执行”。对执行结果不确定的调用，默认进入 `unknown` 或 `interrupted` 状态，而不是再做一次。

## 分支不是回滚

这是整套设计最重要、也最容易被 UI 误导的边界。

假设 Agent 在原分支执行过：

```bash
printf 'hello\n' > result.txt
```

此后用户回到调用该命令之前的节点。变化的只是 Agent 接下来会看到的会话路径；磁盘上的 `result.txt` 仍然存在。

因此，“从这里重试”至少可以有三种明确语义：

1. **仅分支会话**：新分支继续使用当前世界状态；
2. **分支并新建隔离环境**：例如从指定 Git commit 创建 worktree；
3. **分支并执行显式补偿**：由业务层撤销可逆的副作用。

这三种选项的成本和风险完全不同，不应被一个含糊的“回退”按钮混在一起。

## History 不是 Context

持久历史优先完整，模型上下文优先有用。两者的优化目标不同。

完整历史可能包含：

- 只供调试的运行时事件；
- 已被总结覆盖的早期对话；
- 中断的 assistant 输出；
- 结果未知的工具调用；
- 审批、重试和锁等管理事件；
- 不应向某个模型供应商暴露的内部数据。

这些信息对审计有价值，却不一定应该全部进入下一次推理。因此需要一个显式的 Context Projection：

```text
project(active_path, model, token_budget, policy) -> model_context
```

一个可用的投影器通常依次做五件事：

1. 找到活动 head 到根的唯一路径；
2. 选择该路径上最新、可信的 checkpoint；
3. 丢弃纯内部事件，保留必要的用户意图和运行结果；
4. 修复供应商协议要求，例如保证 tool call 与 tool result 合法配对；
5. 在 token 预算内产生最终消息，并记录本次投影的版本和输入节点。

这一层让 Session Store 与具体模型协议解耦：存储层不需要知道下游使用 OpenAI、Anthropic 还是本地模型；更换供应商时，也不需要改写历史。

## Compaction 是新视图，不是删除历史

长时间运行的 Agent 一定会超过模型的上下文预算。直接删掉旧消息虽然简单，但会让审计、重新总结和从旧节点分支变得不可能。

更合理的做法是在历史中追加 checkpoint：

```text
A → B → C → D → K → E → F
                └─ K 概括 A..D
```

`K` 不取代 `A..D`，只是提供一个更便宜的投影起点。下一次模型可以看到 `Summary(A..D) + E + F`，而审计系统仍然可以读取原始节点。

一个高质量 checkpoint 不只有自然语言摘要，还应尽量结构化地保留：

- 当前目标和已确认约束；
- 已做出的关键决策及理由；
- 已知的环境状态与资源标识；
- 未完成任务、风险和待确认问题；
- 摘要覆盖的起止节点和生成器版本。

这样，compaction 才不是一次不可验证的“历史遗忘”，而是一个可以替换、重新生成和对比评估的视图。

## 工具调用是有副作用的事件

普通对话在中断时，最坏通常只是少了一段回复。Agent 的中断却可能发生在这个窗口：

```text
1. tool call 已持久化
2. 工具已在外部系统中执行成功
3. tool result 尚未持久化
4. 进程崩溃
```

恢复时只看历史，系统会看到一个没有结果的调用。如果它自动重放，就可能重复发送邮件、重复扣款或重复修改文件。

因此，工具调用至少需要表达以下状态：

```text
proposed → approved → dispatched → succeeded
                               ├→ failed
                               └→ unknown
```

`unknown` 的语义是：副作用可能已经发生，但当前系统无法证明。对它的处置取决于工具性质：

| 工具类型 | 恢复策略 |
| --- | --- |
| 纯读取 | 通常可以重试 |
| 有幂等键的写入 | 使用原幂等键查询或重试 |
| 可查询的非幂等写入 | 先查询外部状态，再决定是否补做 |
| 不可查询的非幂等写入 | 停止自动执行，请求人工判断 |

为了让投影后的模型协议仍然完整，可以追加一条中断结果：

```text
Interrupted: execution outcome is unknown.
Side effects may have occurred. Inspect the current world state before retrying.
```

它不是伪造一个“执行失败”，而是忠实表达系统当前所知的边界。

## 四个核心操作的精确语义

### Append：在预期 head 之后追加

最小写入接口不应只接收 `branch_id` 和新节点，还应带上调用方读到的 `expected_head` 或 `version`：

```python
append(
    branch="main",
    expected_head="node_42",
    new_node=HistoryNode(parent_id="node_42", ...),
)
```

存储层只在当前 head 仍然是 `node_42` 时提交。这是一次 compare-and-swap，它防止两个 worker 同时读到旧 head 后互相覆盖。

冲突发生时，调用方可以重读最新分支并重新计算、显式创建一条新分支，或放弃过期输出。不应静默采用“后写入覆盖先写入”。

### Branch：创建新引用，不复制节点

```python
branch(name="experiment-b", from_node="node_17")
```

这个操作的本质是新建 `BranchRef(name, head_id="node_17")`。原分支、新分支共享 `node_17` 及其所有祖先，只在后续写入中分岔。

### Project：将一条历史路径转为模型输入

Projection 必须是纯函数或至少具备确定性：给定相同的历史、策略、模型协议和预算，应产生相同输出。如果其中需要调用 LLM 总结，总结结果应先作为 checkpoint 持久化，而不是每次读取时临时生成。

### Recover：重建内存视图，不重放现实动作

恢复可以重放的是持久化事件，用它们重建 node index、branch refs、active head、pending tool calls 和 latest checkpoints。

恢复不能因为读到 `tool_call` 就再次调用真实工具。“重放日志”与“重放副作用”必须是两条完全不同的代码路径。

## 一个可落地的存储轮廓

小型系统并不需要先引入复杂框架。SQLite 中两张核心表已经能支撑基本模型：

```sql
CREATE TABLE history_nodes (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    parent_id   TEXT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES history_nodes(id)
);

CREATE TABLE branch_refs (
    session_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    head_id     TEXT NOT NULL,
    version     INTEGER NOT NULL,
    PRIMARY KEY (session_id, name),
    FOREIGN KEY (head_id) REFERENCES history_nodes(id)
);
```

写入时在同一个数据库事务中：

1. 校验 `branch_refs.version` 与调用方的预期一致；
2. 插入新节点；
3. 将 branch head 指向新节点，并递增 version；
4. 提交事务。

如果需要完整的 append-only 审计，可以再增加 `session_events` 表，记录 ref 移动、分支创建和 checkpoint 生成。`branch_refs` 此时只是一个为高效读取而保留的物化视图，丢失后可从事件重建。

### 节点粒度要保持一致

可以把一条 message 作为节点，也可以把一个完整 turn 作为节点。两者都能工作，但不应随意混用。

对工具型 Agent，更细的事件粒度通常更容易表达中断和部分成功：

```text
user_message
→ assistant_message
→ tool_call
→ tool_result
→ assistant_message
```

但 UI 可以把这些底层节点聚合成一个 turn 展示。底层存储粒度不必与界面粒度一致。

## 系统分层：让每一层只保守一类语义

```text
┌─────────────────────────────┐
│          Interface / UI         │
└───────────────┬─────────────┘
                │
┌───────────────▼─────────────┐
│         Application Layer       │
│ branch / resume / runtime wiring│
└──────────┬──────────┴─────────┘
           │                    │
           ▼                    ▼
┌──────────────┐    ┌──────────────┐
│  Agent Runtime │    │ Session Store│
│ model/tool loop│    │ tree / refs  │
└───────┬──────┘    └──────────────┘
        │
        ▼
┌──────────────┐
│ Context Layer│
│ path → input │
└───────┬──────┘
        │
        ▼
┌──────────────┐
│ Provider / LLM│
└──────────────┘
```

- **Session Store** 负责历史节点、分支引用、原子写入和恢复；
- **Context Layer** 负责把活动路径投影成某个模型可接受的输入；
- **Agent Runtime** 负责模型—工具循环、执行状态和中断处理；
- **Application Layer** 负责把用户操作翻译成 branch、resume 和 environment 策略；
- **UI** 负责把“会话分支”与“环境回滚”的差异讲清楚。

这种分层的价值不是形式整齐，而是让错误留在正确的边界内。例如，模型协议变化应由 Context Layer 吸收，而不应迫使持久层改写旧节点。

## 它不是完整的 Event Sourcing

这套设计借用了 Event Sourcing 的一些思想：只追加记录、由日志重建内存视图、将物化状态视为投影。但不必因此把整个 Agent 系统包装成 Event Sourcing 框架。

关键区别在于：Session 日志能重建的是会话与运行时视图；它通常不是文件系统、邮件服务和第三方 API 的事实来源；重建 Session 状态不能重建整个外部世界。

更准确的表述是：这是一个使用 append-only log 实现的可分支轨迹存储，它采用了事件溯源的部分原则，但没有声称拥有所有业务状态。

## 什么时候值得使用

可分支 Session 会引入 parent 索引、ref 管理、投影和冲突控制，并非所有应用都值得付出这些复杂度。

它更适合：

- 任务会长时间运行，需要中断后恢复；
- 用户经常从中间节点试验其他方案；
- Agent 会执行工具，必须审计副作用；
- 上下文需要多次压缩、重新总结或迁移模型；
- 系统需要对比不同轨迹，用于评测、调试或人工选择。

如果产品只是短对话、不调工具、不恢复、也不允许分支，一个线性 `messages[]` 反而更清楚。数据模型的先进不在于它能表达多少，而在于它是否刚好表达了产品真正需要的语义。

## 实现检查清单

上线前，可以用这组问题检查设计是否闭环：

- 从任意 branch head 出发，是否都能到达唯一根节点？
- 创建分支是否只新建 ref，而不是复制整段历史？
- 并发写入是否通过 expected head 或 version 检测冲突？
- 每次模型调用是否能追溯到确切的 head、checkpoint 和 projection version？
- checkpoint 是否只是新投影，原始节点仍然保留？
- 崩溃恢复时，是否会把未知结果误当成未执行？
- 工具调用是否携带稳定 call id，可幂等工具是否携带幂等键？
- UI 是否明确告知用户：切换对话分支不会自动回滚环境？
- 如果分支需要隔离环境，Session 与 environment id 是否建立了显式关联？
- 持久层是否可以在不调用模型、不执行工具的情况下独立恢复？

## 结语

当 Agent 只会聊天时，Session 是一串消息。

当 Agent 开始长期运行、使用工具、压缩上下文并从过去的节点展开新探索时，Session 更像一个轨迹版本库：

- 历史树保存全部已发生事实；
- branch ref 指出当前从哪里继续；
- Context Projection 决定模型此刻需要看到什么；
- checkpoint 降低上下文成本，却不销毁原始历史；
- 环境与会话保持独立，工具副作用从不被隐式重放。

这套设计真正解决的，不是“如何保存更多聊天记录”，而是：

> **如何在不改写过去、不伪造环境回滚、不重放未知副作用的前提下，让 Agent 从任意一段过去安全地生长出新的未来。**
