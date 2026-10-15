---
id: function-calling
date: 2026-06-01
category: agent
title: OpenAI Function Calling：从工具协议到可靠执行循环
---

# OpenAI Function Calling：从工具协议到可靠执行循环

Function Calling 最容易被误解的地方，就在它的名字里：模型并没有真正调用函数。

对自定义 function tool 来说，模型做的是生成一条结构化请求：

```json
{
  "name": "get_weather",
  "arguments": {
    "location": "Paris, France",
    "unit": "celsius"
  }
}
```

应用才是真正的执行者。它需要解析参数、验证权限、调用本地或远程代码，再把结果交回模型。

> **Function Calling 是模型与应用之间的有类型协议，不是远程函数自动执行器。**

理解这条边界，是正确实现后续所有安全、错误处理和审计逻辑的前提。

## 三层契约，不要混在一起

一次工具调用同时涉及三层契约：

| 层次 | 负责什么 | 无法保证什么 |
| --- | --- | --- |
| 模型协议 | 工具名、参数结构、调用与结果的关联 | 用户是否有权执行 |
| 应用调度 | 解析、白名单、超时、审批、重试与结果回传 | 外部业务是否真正完成 |
| 业务系统 | 幂等、事务、资源版本和最终状态 | 模型是否正确理解用户意图 |

`strict: true` 只能加强第一层的结构契约。一个参数完全符合 JSON Schema 的退款请求，仍可能越权、重复或指向错误订单。

## Responses API 的五步循环

OpenAI 官方文档将自定义工具循环概括为五步：

```text
1. 应用把输入和可用工具发给模型
2. 模型返回 function call
3. 应用执行工具
4. 应用把 function call output 发回模型
5. 模型生成回答，或者继续请求工具
```

最后一步不一定是自然语言答案，它可能是另一批工具调用。因此工具使用必须实现为有上限的循环，不是固定的两次 API 请求。

## 工具定义：Schema 是协议，描述是选择器

Responses API 中的 function tool 使用扁平定义：

```python
tools = [
    {
        "type": "function",
        "name": "get_weather",
        "description": (
            "Get the current weather for one city. "
            "Use this only when the user needs current conditions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and country, e.g. Paris, France",
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                },
            },
            "required": ["location", "unit"],
            "additionalProperties": False,
        },
        "strict": True,
    }
]
```

这个定义同时面向两个读者：

- 模型通过 `name` 和 `description` 判断何时选择工具；
- 协议层通过 `parameters` 和 `strict` 约束参数形状。

好的工具描述不只解释“工具做什么”，还会说清：

- 什么时候应该用；
- 什么时候不应该用；
- 参数的单位、格式和业务含义；
- 与相似工具的区别。

如果两个工具的描述高度重叠，后端再严格的 Schema 也不能阻止模型选错工具。

## Strict mode 保证了什么

OpenAI 官方建议对 function tool 启用 `strict: true`。当显式启用时：

1. 每个 object 都需要设置 `additionalProperties: false`；
2. `properties` 中定义的字段都要列入 `required`；
3. 逻辑上可选的字段可通过包含 `null` 的类型表达。

例如：

```json
{
  "type": "object",
  "properties": {
    "query": {"type": "string"},
    "language": {"type": ["string", "null"]}
  },
  "required": ["query", "language"],
  "additionalProperties": false
}
```

不同 API 在未显式填写 `strict` 时的行为不完全相同：

- Chat Completions 默认为 non-strict、best-effort；
- Responses API 会在可能时尝试将 Schema 规范化为 strict，无法兼容时回退为 non-strict。

需要确定性时，应显式填写 `strict: true`，并在开发和 CI 阶段验证工具 Schema，而不是依赖服务端猜测意图。

Strict mode 不保证：

- 城市、订单或用户真实存在；
- 当前身份有权访问目标资源；
- 字符串中的 URL、SQL、路径或 shell 内容安全；
- 这次操作符合用户真实意图；
- 写操作不会被重复执行。

Schema 验证之后，仍然需要业务验证、权限检查和执行策略。

## `call_id` 是循环的关联键

模型决定调用工具时，`response.output` 中会出现 `function_call` item：

```json
{
  "type": "function_call",
  "call_id": "call_abc123",
  "name": "get_weather",
  "arguments": "{\"location\":\"Paris, France\",\"unit\":\"celsius\"}"
}
```

`arguments` 是 JSON 编码的字符串，应用需要先解析。工具完成后，应用返回：

```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "{\"ok\":true,\"temperature\":25,\"unit\":\"celsius\"}"
}
```

`call_id` 必须原样回传。它表达的不是“这是第几个结果”，而是“这个结果属于哪次具体调用”。

一轮可能返回多个 function call，完成顺序也可能与生成顺序不同。因此不能靠数组下标或到达顺序关联结果。

## 一个完整、可运行的 Responses 循环

下面的例子使用手动维护的 `input_items`，因为它能直接展示协议中每种 item 的位置。

```python
import json
import os
from typing import Any

from openai import OpenAI


client = OpenAI()
MODEL_ID = os.environ["OPENAI_MODEL"]
MAX_TOOL_ROUNDS = 6


def get_weather(location: str, unit: str) -> dict[str, Any]:
    # 真实项目中调用外部天气服务。
    return {"location": location, "temperature": 25, "unit": unit}


def dispatch(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "get_weather":
        return get_weather(**arguments)
    raise ValueError(f"Unknown tool: {name}")


input_items: list[Any] = [
    {"role": "user", "content": "What's the weather in Paris?"}
]

for _ in range(MAX_TOOL_ROUNDS):
    response = client.responses.create(
        model=MODEL_ID,
        input=input_items,
        tools=tools,
    )

    # 保留全部 output items，不要只保留 function_call。
    input_items.extend(response.output)

    calls = [item for item in response.output if item.type == "function_call"]
    if not calls:
        print(response.output_text)
        break

    for call in calls:
        try:
            arguments = json.loads(call.arguments)
            result = dispatch(call.name, arguments)
            envelope = {"ok": True, "result": result}
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            # 返回给模型的错误应稳定且已清洗。
            # 完整堆栈与敏感参数留在服务端日志。
            envelope = {
                "ok": False,
                "error": {
                    "code": "INVALID_TOOL_CALL",
                    "retryable": False,
                    "message": str(exc),
                },
            }

        input_items.append(
            {
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": json.dumps(envelope, ensure_ascii=False),
            }
        )
else:
    raise RuntimeError("Tool loop exceeded its round budget")
```

这段代码展示了协议主干，但还不是生产级执行器。真实系统至少还要加入：

- 工具白名单与独立的参数验证；
- 用户、租户和资源级权限检查；
- 工具级超时、整体 deadline 与取消；
- 副作用审批与幂等键；
- 重试预算、调用次数和成本上限；
- 按 `call_id` 持久化的执行状态；
- 对最终业务结果的外部验证。

## 为什么要保留完整 `response.output`

Responses API 的 `output` 是 item 列表，不保证只包含一条 assistant message 或 function call。对会返回 reasoning items 的模型，官方文档要求在继续工具循环时也传回这些 items。

因此，手动维护输入时应保留：

```python
input_items.extend(response.output)
```

不要自己重建一个只包含工具名和参数的缩减版 assistant message。应用只应解析公开协议字段，不要猜测服务端内部序列化形式。

## 错误也是工具结果

参数无效、上游限流和业务拒绝都不应让工具循环直接断裂。应用应把可恢复的错误转成稳定结果包：

```json
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_RATE_LIMITED",
    "retryable": true,
    "message": "Weather provider is temporarily unavailable."
  }
}
```

这让模型能够选择改变参数、换用工具、向用户追问或停止。但返回给模型的内容应经过清洗，不应包含：

- 完整异常堆栈；
- 数据库连接串、密钥或内部网络信息；
- 可被直接注入到 SQL 或 shell 的未转义内容；
- 远程服务返回的不可信指令。

对写操作超时，错误包不应轻率标记 `failed`。请求可能已经在外部系统生效，此时应返回 `unknown` 或进入状态核对，而不是盲目重试。

## `tool_choice` 控制选择空间

`tool_choice` 决定模型本轮可以如何选择工具：

| 模式 | 语义 | 适用场景 |
| --- | --- | --- |
| `auto` | 可直接回答，也可调用工具 | 通用 Agent 循环 |
| `required` | 至少调用一个工具 | 答案必须基于外部数据 |
| `none` | 本轮禁止工具 | 只允许总结或格式化 |
| 指定 function | 强制调用某个函数 | 应用已确定下一个操作 |
| allowed tools | 只允许使用工具集的子集 | 按阶段或权限收窄动作空间 |

工具清单不应在整个任务中固定不变。在“查询”阶段可以只提供读工具；用户确认后，再为特定资源开放对应写工具。这比一开始就把所有高风险能力交给模型更容易审计。

## 一轮多调用不等于可以盲目并发

在支持的模型上，一轮可能返回多个 function call。`parallel_tool_calls: false` 可将一轮限制为零个或一个调用。

但“模型一次产生了多个调用”只是协议事实，不是调度决定。

```text
get_weather("Beijing")
get_weather("Shanghai")
```

两个独立查询通常可以并发。

```text
get_balance(account_1)
transfer(account_1, account_2, amount)
```

后一个调用可能依赖前一个结果，应串行且再次校验。

```text
close_account(account_1)
update_profile(account_1)
```

两个调用虽然没有参数依赖，却会竞争同一个业务资源。

应用需要根据依赖、副作用、幂等性和资源冲突决定如何执行。这是 Tool Orchestrator 的职责，也是本系列下一篇文章的主题。

## Chat Completions 的协议差异

Chat Completions 仍支持 function calling，但协议形状不同：

| 环节 | Responses API | Chat Completions |
| --- | --- | --- |
| 请求历史 | `input` items | `messages` |
| 工具定义 | `{type, name, parameters, strict}` | `{type, function: {...}}` |
| 模型调用 | `function_call` item | assistant message 的 `tool_calls` |
| 调用关联 | `call_id` | `tool_calls[].id` |
| 工具结果 | `function_call_output` item | `role: "tool"` message |
| 结果关联 | `call_id` | `tool_call_id` |

Chat Completions 中，应用必须先把包含 `tool_calls` 的完整 assistant message 加入 `messages`，再为每个调用追加一条 `role: "tool"` 消息。

维护旧系统时可以继续使用 Chat Completions；新的多步工具循环则更适合优先评估 Responses API。迁移时不要只改 endpoint，还要改造历史结构、工具定义和结果关联方式。

## 八个常见的协议错误

### 1. 只处理第一个 function call

一轮可能有多个调用。丢掉其余调用会让对话历史与结果不完整。

### 2. 把 `arguments` 当作已解析对象

Responses 与 Chat Completions 的 function arguments 都是 JSON 字符串。必须解析并检查失败。

### 3. 丢失或重写 `call_id`

结果必须与原始调用精确对应。自行生成新 ID 会破坏协议链。

### 4. 只传回工具调用，丢掉其他 output items

继续循环时，应保留完整模型输出。对 reasoning 模型尤其重要。

### 5. 用 strict mode 取代授权

Schema 合法不代表业务合法。权限、审批和资源边界必须在应用侧检查。

### 6. 将完整内部异常发回模型

这会泄露实现细节和敏感数据。应使用稳定、可分类的错误码。

### 7. 没有循环上限

模型可能在空结果或参数错误之间反复调用。必须同时限制轮数、时间、调用次数和成本。

### 8. 把“模型不再调工具”当作业务完成

最终文本是模型的结论，不是外部世界的证明。对付款、发送、删除和文件修改，需要独立验证最终状态。

## 工具循环需要记录什么

为了调试、评测和审计，每次调用至少应关联：

```text
run_id
response_id
call_id
tool_name
schema_version
arguments_digest
authorization_decision
approval_id
started_at / finished_at
status
retry_count
result_digest
```

敏感参数和完整结果不应默认写入日志。可观测的目标是解释系统为什么做出某次调用，不是复制一份无限期保留的业务数据库。

## 结语

OpenAI Function Calling 提供了一套让模型表达工具意图的协议：

- 工具通过名称、描述和 JSON Schema 声明；
- 模型通过 `function_call` 提出调用；
- 应用通过 `call_id` 将结果精确关联回原调用；
- 模型可以继续调用工具，直到循环完成或运行时终止。

协议层让“模型想做什么”成为程序可以解析的数据，但真正的可靠性始终来自应用侧：

> **模型负责提出调用，应用负责验证、授权、执行、关联与证明结果。**

参考：

- [OpenAI Function Calling 官方文档](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Responses API 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)
