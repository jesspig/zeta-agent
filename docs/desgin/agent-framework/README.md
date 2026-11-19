# Agent 框架设计（agent-framework）

> **目录定位**：`@zeta-agent/agent-framework` 的**内部组件与对外 facade**。由 loop/inbox/tools/decision/session/stream 等组件拼装，构建在通用框架 facade 之上；零内置工具、零 provider、零持久化。
> **所属索引**：[总索引](../README.md)　|　**架构依据**：[architecture/framework-model.md](../architecture/framework-model.md)

## 文档清单

| 文档 | 内容 | 粒度 |
| --- | --- | --- |
| [overview.md](./overview.md) | 定位、包边界与依赖、facade 出口 | 总览 |
| [runtime.md](./runtime.md) | 公开 API、AgentPlugin 管线、runLoop、取消与中断 | 运行时 |
| [tools-and-policies.md](./tools-and-policies.md) | 顺序敏感、工具流水线、权限与沙箱 hook | 工具与策略 |
| [state-and-events.md](./state-and-events.md) | 事件协议、状态管理、模型 broker、不变量与风险 | 状态与事件 |

## 时序图（一次 prompt 的完整链路）

```mermaid
sequenceDiagram
    participant APP as 应用形态
    participant AG as Agent (facade)
    participant LP as loop 组件
    participant EV as events 组件
    participant TL as tools 组件
    APP->>AG: prompt(messages)
    AG->>LP: runLoop(input)
    LP->>EV: agent/pre-step (waterfall)
    EV-->>LP: enter(messages)
    LP->>LP: streamAssistantResponse
    LP->>EV: message_start/update/end (emit)
    LP->>TL: tool/call*
    TL->>TL: pre-execute → guard → execute → post-execute
    TL-->>LP: tool_execution_end (完成顺序)
    LP->>EV: agent/turn-stopping (serial)
    LP-->>AG: AgentEvent 流
    AG-->>APP: 事件 + 最终消息
```

## 活动图（工具流水线）

```mermaid
flowchart TD
    S[tool/call 落盘] --> P[presentCall]
    P --> PRE[tools/pre-execute waterfall]
    PRE --> G[单调 guard: 只 deny]
    G -->|通过| AP[approval ask 可选]
    G -->|拒绝| R[error result + reason]
    AP --> EX[tools/execute around: timeout/retry/metrics]
    EX --> BODY[tool body + fs 意图事件]
    BODY --> PC[projectContent]
    PC --> POST[tools/post-execute waterfall]
    POST --> FC[finalizeContent]
    FC --> RES[tools/result 同步冻结]
    RES --> LOG[tool/result 落盘]
```

## 跨目录关系

- 上游：[architecture/framework-model.md](../architecture/framework-model.md)、[framework](../framework/README.md) 的 facade。
- 下游：[agent/plugin-system.md](../agent/plugin-system.md) 用插件装配出具体 agent；[agent/tui.md](../agent/tui.md) 订阅事件。
- 不变量清单：[research/pi-baseline.md](../research/pi-baseline.md) 与 [state-and-events.md](./state-and-events.md)。
