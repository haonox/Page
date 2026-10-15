---
id: react
date: 2026-05-21
category: agent
title: ReAct：让 Agent 在行动与反馈中修正自己
---

# ReAct：让 Agent 在行动与反馈中修正自己

一个模型可以一次性写出完整计划：先搜索客户，再查询订单，最后发起退款。但真实世界不会按计划配合：客户可能有多个同名账户，订单可能已过退款期，支付系统也可能在执行时超时。

如果 Agent 只在开始时思考一次，后面就照单全收，任何一个假设失效都会污染整条轨迹。

ReAct 提供的核心思路是：

> **不把推理和行动分成两个孤立阶段，而是让模型根据每次行动的真实反馈，持续更新判断和下一步。**

它把一次静态生成，变成一个闭环控制过程。

## ReAct 究竟改变了什么

ReAct 来自 Shunyu Yao 等人的论文 [*ReAct: Synergizing Reasoning and Acting in Language Models*](https://arxiv.org/abs/2210.03629)，预印本于 2022 年发布，后收录于 ICLR 2023。论文对比了四类方法：

| 方法 | 能多步推理 | 能与环境交互 | 核心局限 |
| --- | --- | --- | --- |
| Standard | 否 | 否 | 一次性生成，难以处理复杂任务 |
| Chain-of-Thought | 是 | 否 | 推理可以很长，但缺少外部事实校正 |
| Act-only | 否 | 是 | 可以操作环境，但缺少目标分解与进度跟踪 |
| ReAct | 是 | 是 | 在推理、行动与观察之间循环 |

关键不是在提示词中写下 `Thought` 和 `Action` 这两个标签，而是形成了两条相互修正的路径：

```text
Reason to act：当前信息不够，需要做什么才能继续？
Act to reason：环境刚刚返回了什么，它如何改变原来的判断？
```

行动为推理带来新证据，推理则决定哪种行动最值得执行。

## 用状态转移理解循环

经典的 ReAct 轨迹常被写成：

```text
Thought → Action → Observation → Thought → ... → Final Answer
```

从工程角度看，它更像一个状态转移系统。设第 `t` 步的 Agent 状态为：

```text
S_t = goal + known facts + task state + previous observations + remaining budget
```

模型基于 `S_t` 选择一个动作：

```text
A_t = policy(S_t)
```

环境执行动作并返回观察：

```text
O_t = environment(A_t)
```

运行时再将观察合并进新状态：

```text
S_(t+1) = update(S_t, A_t, O_t)
```

这个表达暴露了一个重要事实：ReAct 不只是模型提示技巧，还需要运行时负责工具执行、状态更新、预算、中止和错误处理。

## 一条比“查天气”更完整的轨迹

假设用户要求：

> 找到我最近一笔已支付订单，如果尚未发货，就申请取消。

运行时可以把轨迹表达为：

```text
Goal
  取消最近一笔符合条件的订单

Decision
  需要先确定用户身份与订单

Action
  list_orders(user_id, status="paid", limit=5)

Observation
  返回 3 笔订单；最新订单为 order_42

Decision
  需要核对物流状态，不能直接取消

Action
  get_fulfillment_status(order_id="order_42")

Observation
  status="packing"; cancellation_allowed=true

Decision
  取消会修改外部状态，需要用户确认

Action
  request_confirmation(order_id="order_42", operation="cancel")
```

用户确认后，Agent 再执行取消，并查询订单状态验证结果。

这条轨迹有三个值得注意的点：

1. 模型没有在开始时猜出所有工具参数，而是从观察中逐步获得；
2. “能取消”不等于“应立即取消”，策略层在行动前加入审批；
3. 工具返回“成功”不是任务终点，修改操作还需要独立验证。

这比简单的“思考—调用—回答”更接近生产 Agent 的真实结构。

## 不要把 ReAct 等同于公开 Chain-of-Thought

原始 ReAct 论文使用显式的自然语言 reasoning trace，方便在 few-shot prompt 中展示如何分解目标、跟踪进度和处理异常。但现代生产系统不必、也不应默认向用户展示或在日志中完整保存模型的私有推理过程。

运行时真正需要的是可操作、可审计的控制信息：

- 当前目标与子目标；
- 选择了什么动作；
- 使用了哪些参数和权限；
- 环境返回了什么；
- 哪条策略允许或拒绝了行动；
- 任务为什么继续、暂停或结束。

可以用 `decision_summary`、`next_action`、`evidence_refs` 和 `stop_reason` 等结构化字段保存这些信息。可观测不等于暴露全部隐式思考。

## ReAct 中实际存在三个循环

### 获取证据的循环

```text
提出当前需要验证的问题
→ 搜索或查询
→ 检查返回内容
→ 缩小下一次查询范围
```

这类循环用于多跳问答、故障诊断和信息调查。它的终止条件应是证据充分或检索预算用尽，而不是“模型还能想到新搜索词”。

### 改变世界的循环

```text
读取当前状态
→ 计划最小变更
→ 执行写操作
→ 再次读取并验证
```

这类循环会写文件、修改数据库或操作远程系统。它必须比查询循环更保守：需要权限、幂等、审批、执行后验证和可能的补偿。

### 从错误中恢复的循环

```text
行动失败
→ 将失败分类
→ 判断是否可恢复
→ 重试、换路径、请求帮助或停止
```

错误不应只被处理成一段丢回 prompt 的文字。运行时需要将它归入稳定类别，因为不同错误对应完全不同的恢复策略。

## 错误恢复不是简单地“再试一次”

| 失败类型 | 示例 | 默认处置 |
| --- | --- | --- |
| 参数无效 | 缺少必填字段、枚举值错误 | 修正参数，不消耗工具级重试 |
| 前置信息缺失 | 不知道用户 ID | 调用查询工具或向用户追问 |
| 暂时性故障 | 限流、短暂断网 | 在 deadline 内退避重试 |
| 权限不足 | 账号无退款权限 | 停止当前路径，请求授权或换用允许的目标 |
| 业务冲突 | 订单已发货 | 更新计划，不原样重试 |
| 结果未知 | 写操作超时 | 先核对外部状态，禁止盲目重放 |
| 不可恢复 | 资源已被永久删除 | 结束路径并说明阻塞 |

“工具报错”只是一个现象。安全的 ReAct 系统必须先判断错误语义，再决定下一个动作。

## 六个常见的失败模式

### 1. 循环空转

Agent 反复发出相同或等价的调用，观察没有新信息，却仍然继续。运行时应检测重复动作、重复错误和状态无进展。

### 2. 观察污染

工具结果是外部不可信数据，其中可能包含错误内容或 Prompt Injection。观察可以提供事实，但不能自行改写系统指令、权限和工具范围。

### 3. 旧观察被当作当前状态

在多步或并发系统中，环境可能在观察与执行之间发生变化。高风险写入需要版本号、条件更新或执行前二次校验，不能只信任上一轮查询结果。

### 4. 工具成功被误当作任务成功

`send_email` 返回 HTTP 200，只能说请求被接受，不能自动证明收件人、内容和业务目标都正确。任务终止需要面向用户目标的验证器。

### 5. 上下文不断膨胀

每次 Action 和 Observation 都原样追加，会让噪声、大型工具输出和过期计划逐渐淹没当前状态。需要分开完整轨迹与模型上下文，对观察做规范化、裁剪和 checkpoint。

### 6. 把所有事都交给模型决定

超时、权限、并发限制、审批、幂等和最大步数是系统约束，不应只靠 prompt 提醒。模型选择意图，运行时保守不变量。

## 生产级 ReAct 循环

一个最小但边界清楚的运行时可以写成：

```python
async def run_agent(goal, runtime):
    state = await runtime.initialize(goal)

    while True:
        runtime.guard_budget(state)

        decision = await runtime.decide(
            goal=state.goal,
            context=runtime.project_context(state),
            tools=runtime.allowed_tools(state),
        )

        if decision.type == "finish":
            verdict = await runtime.verify_goal(state, decision.answer)
            if verdict.satisfied:
                return decision.answer
            state = runtime.record_verification_failure(state, verdict)
            continue

        call = runtime.validate(decision.tool_call)
        await runtime.authorize(call, state)

        observation = await runtime.execute(
            call,
            timeout=runtime.timeout_for(call),
            idempotency_key=runtime.idempotency_key(state, call),
        )

        state = await runtime.reduce(state, call, observation)
```

这段代码有两个有意的设计：

- 模型产生的 `finish` 只是完成候选，真正结束前还要验证用户目标；
- 观察不是简单 append 回消息列表，而是通过 `reduce` 更新结构化状态。

真实实现还应包含取消传播、调用级状态机、重试分类、结果持久化和人工确认。

## 终止条件是运行时契约

一个循环如果只有“模型决定结束”，就缺少工程上可证明的边界。完整的终止条件通常包括：

```text
目标已验证完成
OR 模型需要用户补充信息
OR 遇到不可恢复错误
OR 操作需要人工审批
OR 超过步数 / 时间 / 成本预算
OR 检测到重复循环或状态无进展
OR 用户取消
```

这些结果不应都被压成 `failed`。`completed`、`waiting_user`、`waiting_approval`、`blocked`、`budget_exhausted` 和 `cancelled` 对 UI、恢复和审计有不同含义。

## ReAct、Plan-and-Execute 与确定性 Workflow

| 模式 | 何时做决策 | 优势 | 主要代价 |
| --- | --- | --- | --- |
| ReAct | 每获得一次观察后 | 灵活，适合信息不完整和环境变化 | 模型调用多，轨迹难预测 |
| Plan-and-Execute | 先规划，执行中按需重规划 | 整体目标更清楚，便于并行化 | 早期计划可能基于错误假设 |
| Deterministic Workflow | 由程序预先定义 | 可测试、可审计、延迟与成本稳定 | 难以处理未预见的非结构化分支 |

三者不是互斥架构。一个稳健系统往往把它们组合起来：

```text
确定性工作流程保守业务不变量
→ 在需要理解和判断的节点调用 Agent
→ Agent 在有限动作空间内使用 ReAct
```

已经高度固定的退款、审批和发布流程，应优先实现成业务 workflow，而不是让模型每次重新发明步骤。

## 如何评估一个 ReAct Agent

只检查最终答案不足以定位问题。评测应同时覆盖结果和轨迹：

| 维度 | 关键问题 |
| --- | --- |
| 任务成功 | 用户目标是否真正完成，而不是模型声称完成？ |
| 动作正确性 | 是否选对工具、参数和执行顺序？ |
| 证据利用 | 最终结论是否由观察支持？ |
| 恢复能力 | 工具失败、结果为空或环境变化时是否会改变策略？ |
| 效率 | 完成任务用了多少步、token、时间与工具成本？ |
| 安全 | 是否发生越权、未审批写入、重复副作用或注入攻击？ |
| 终止质量 | 是否过早完成、无限循环，或在可恢复时过早放弃？ |

高价值测试应主动注入失败：超时、限流、空结果、过期数据、重复调用、部分成功和恶意工具输出。只在工具永远成功的模拟环境中评估，无法证明 Agent 真的会从反馈中修正自己。

## 结语

ReAct 的持久价值，不在于它发明了一种特定的文本格式，而在于它把环境反馈放回了决策过程：

```text
判断下一步
→ 执行一个受控动作
→ 读取真实反馈
→ 更新状态与计划
→ 验证是否应该继续
```

但循环本身不会带来可靠性。模型可以提出动作并解读观察，运行时必须控制权限、副作用、预算、中止与恢复。

> **ReAct 让 Agent 有机会根据世界修正自己；一个生产级 Runtime 则要确保，这种修正发生在可控、可验证的边界内。**
