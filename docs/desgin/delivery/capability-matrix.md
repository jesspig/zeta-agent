# 能力四态矩阵

> **用途**：区分“组件存在”“显式注入可用”“默认启用”“验收通过”，避免把孤立测试或 seam 当作完整交付。
> **基线**：`develop f36f457`，2026-11-24 核对。

## 状态口径

- **组件存在**：已有实现文件和直接测试。
- **显式注入可用**：SDK/调用方可通过公开 API 注入并运行。
- **默认启用**：默认 CLI、`createAgent()` 或标准 profile 实际装配。
- **验收通过**：对应设计验收有端到端证据；仅有组件测试记“部分”。

## 当前能力矩阵

| 能力 | 组件存在 | 显式注入可用 | 默认启用 | 验收通过 | 证据/限制 |
| --- | --- | --- | --- | --- | --- |
| Framework Context/Fiber | 是 | 是 | 否 | 部分 | `packages/framework/src/context.spec.ts`；provider/effect/guard 主链路未闭环 |
| 事件五模式 | 是 | 是 | 部分 | 部分 | `packages/components/events`；agent facade 使用独立同步总线 |
| Registry/Seam/Health | 是 | 是 | 否 | 部分 | `packages/components/capabilities`；全局状态与 realm 隔离不足 |
| Loader/HMR | 是 | 部分 | 否 | 否 | `hmr.ts` 为 FiberId 简化状态机，未接真实 Agent/CLI |
| Objects 进程内最小集 | 是 | 是 | 否 | 部分 | `packages/framework/src/objects`；无 host/facet/Reference/IPC/WS/SQLite/rollout |
| Agent Event/State | 是 | 是 | 是 | 部分 | 10 类事件存在；idle、newMessages、listener 屏障未闭环 |
| Agent Framework `createAgent` | 是 | 是 | 否 | 否 | 公开 core Agent 未直接集成测试；异步 prepareRequest 路径不可靠 |
| Agent Facade `createAgent` | 是 | 是 | 是 | 部分 | CLI 默认路径；工具/会话/压缩/审计未统一装配 |
| Provider OpenAI 兼容 | 是 | 是 | 是 | 部分 | 无统一 done/error/usage/retry/broker |
| 内置 read/ls/grep/find | 是 | 是 | 是 | 是 | cwd confine + realpath；无审批/审计 |
| 内置 write/edit | 是 | 部分 | 否 | 否 | 默认 backend unsupported；宿主直写实现尚存 |
| bash/powershell | 是 | 部分 | 否 | 否 | 默认 backend unsupported；无真实隔离 backend |
| 统一 ToolPipeline | 是 | 是 | 否 | 部分 | facade/core 仍走自定义串行执行器 |
| Permission/Approval | 是 | 是 | 否 | 部分 | 显式 gate 热更新可用；无 policy AST/四态审批 |
| Durable Effects | 是 | 是 | 是（内存） | 否 | 默认内存 journal；无自动 recover/崩溃窗口/幂等 adapter |
| Egress | 是 | 是 | 部分 | 否 | 仅检查工具参数 url/target；provider/shell 无数据面强制 |
| Credential Broker | 是 | 是 | 否 | 部分 | 显式 vault 路径可用；CLI/model discovery/image 未统一接入 |
| AuditSink | 是 | 是 | 否 | 部分 | 显式 socket 可签名/封存；默认无 sink，重启链与认证不足 |
| Realm 多租户 | 是 | 部分 | 否 | 否 | framework 事件分桶；provider/host/system/facade 未隔离 |
| SessionStore | 是 | 是 | 是（内存） | 否 | JSONL tree 独立存在；默认不持久化/恢复 |
| Compaction/Offloader | 是 | 是 | 否 | 部分 | typed recap 原语存在；默认未装配、peak 未生效 |
| Skills/Resources | 是 | 部分 | 否 | 部分 | 独立 registry；facade 只有服务名占位 |
| MCP | 是 | 部分 | 否 | 否 | 假 transport 最小实现；无握手/OAuth/schema/双结果 |
| TUI/OpenTUI | 是 | 是 | 是 | 部分 | 真实帧测试存在；输入完整性、OSC、槽位热替换未闭环 |
| CLI print/json/rpc | 是 | 是 | 是 | 部分 | 模式函数可用；无子进程/PTY/完整控制面验收 |
| Deploy local/daemon/remote | 是 | 是 | 否 | 否 | 当前为同一 handle 的枚举标签 |
| Research/Promotion/Fitness | 是 | 部分 | 否 | 否 | 可选 seam；默认 promote 可绕过护栏，无冻结重放 |
| Observability | 是 | 是 | 否 | 部分 | logger/redactor 存在；observer 全局、无真实 effect 树/OTLP 降级 |

## 目标状态

完整系统要求上表所有“否/部分”项在对应阶段变为“是”，并满足以下约束：

- 默认 profile 可以保持安全收敛，但不得以占位实现掩盖未完成能力。
- 研究轨、daemon/remote、跨进程对象默认禁用，但必须真实实现并通过独立 profile 验收。
- 任何“验收通过”都必须对应公共 API、端到端场景和可复现证据，不能只引用组件测试名称。
