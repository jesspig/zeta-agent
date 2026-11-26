# 能力四态矩阵

> **用途**：区分“组件存在”“显式注入可用”“默认启用”“验收通过”，避免把孤立测试或 seam 当作完整交付。
> **基线**：`develop@af37607`（2026-11-26）。当前 CI 证据：三平台 39/39 job、1421 pass / 1 skip / 287 files。`develop @ 3c2ec55` / `develop f36f457` 为 historical 基线，不再表示当前状态。
> **总验收**：运行 `bun scripts/acceptance-report.mjs` 与 `bun scripts/release-check.mjs`，生成物位于被忽略的 `reports/`；v2 契约已冻结（T-01）但尚未在当前基线重跑，不能宣称 40/40。发布流程见 [release-runbook](./release-runbook.md)。

## 状态口径

- **组件存在**：已有实现文件和直接测试。
- **显式注入可用**：SDK/调用方可通过公开 API 注入并运行。
- **默认启用**：默认 CLI、`createAgent()` 或标准 profile 实际装配（`local-safe` / `local-full`，见下方机器可读清单）。
- **验收通过**：对应设计验收有端到端证据；仅有组件测试记“部分”。

## 当前能力矩阵

| 能力 | 组件存在 | 显式注入可用 | 默认启用 | 验收通过 | 证据/限制 |
| --- | --- | --- | --- | --- | --- |
| Framework Context/Fiber | 是 | 是 | 是 | 是 | `packages/framework/src/context.ts`、`packages/components/cordis/src/fiber.ts`；provider/effect/guard 主链路见 `context.spec.ts`、`fiber.spec.ts`、`packages/testing/src/properties.spec.ts` |
| 事件五模式 | 是 | 是 | 部分 | 部分 | `packages/components/events` 已实现五模式与错误事件；agent facade 仍使用独立同步总线，未统一到 framework 事件实现 |
| Registry/Seam/Health | 是 | 是 | 部分 | 部分 | `packages/components/capabilities`；`context.tenant.spec.ts` 验证 realm 分桶，全局 observer 与严格 realm 语义仍未全量默认化 |
| Loader/HMR | 是 | 是 | 是 | 是 | `packages/components/loader/src/hmr.ts`、`packages/agent/src/plugins/hot-reload.e2e.spec.ts`、`apps/zeta-cli/src/hot-reload.spec.ts`；真实文件变更不重启生效、digest 复用、apply 失败留 FAILED |
| Objects 进程内 + 跨进程最小集 | 是 | 是 | 否 | 部分 | `packages/framework/src/objects/`（host/facet/Reference/admission/store/link/delta/jobs/rollout）、`packages/agent/src/tenant/object-*.spec.ts`；SQLite/WAL/outbox、IPC(worker_threads)/WS(loopback) 已实现，IPC 非 OS 子进程，默认 realm 不装配 |
| Agent Event/State | 是 | 是 | 是 | 是 | `packages/agent-framework/src/runtime/agent.spec.ts`、`core.lifecycle.spec.ts`；agent_end 屏障、newMessages 与 listener 等待已闭环 |
| Agent Framework `createAgent` | 是 | 是 | 部分 | 部分 | `packages/agent-framework/src/runtime/core.lifecycle.spec.ts` 验证异步 prepareRequest 与并发拒绝；默认 CLI 走 facade 装配 |
| Agent Facade `createAgent` | 是 | 是 | 是 | 部分 | 默认 CLI 路径；统一 ToolPipeline/会话/压缩/审计已接线，shell 与 write/edit 仍受 ExecutionBackend 能力约束，unsupported 时失败关闭 |
| Provider OpenAI 兼容 | 是 | 是 | 是 | 是 | `packages/agent/src/providers/conformance.spec.ts`、`retry.spec.ts`、`broker.spec.ts`；终态/usage/retry/broker 全通 |
| 内置 read/ls/grep/find | 是 | 是 | 是 | 是 | `packages/agent/src/tools/backend.contract.spec.ts`、`confinement.spec.ts`；cwd confine + realpath 双校验 |
| 内置 write/edit | 是 | 是 | 部分 | 部分 | local-safe backend 的结构化操作可用（`backend.structured.spec.ts`）；默认 shell 操作 unsupported，不伪装成功 |
| bash/powershell | 是 | 是 | 部分 | 部分 | `packages/components/security/src/backend.shell.spec.ts`、`backend.matrix.spec.ts`；沙箱档位在 Windows/Linux/Darwin 均声明 unsupported，无真实隔离执行器 |
| 统一 ToolPipeline | 是 | 是 | 是 | 是 | `packages/agent-framework/src/tools/pipeline.t08.spec.ts`、`packages/agent/src/facade.pipeline.t08.spec.ts`；prepare/execute/finalize、completion sink、fail-closed |
| Permission/Approval | 是 | 是 | 部分 | 部分 | `packages/agent/src/plugins/permissions/{policy,approval}.spec.ts`；AST override/restrict、四态审批已实现，默认权限维度仍按兼容口径 |
| Durable Effects | 是 | 是 | 是（内存） | 部分 | `packages/agent/src/plugins/effects/durable.crash.spec.ts`；显式 durable 后端通过双崩溃窗口测试，默认内存 journal 不称 crash-durable |
| Egress | 是 | 是 | 是 | 是 | `packages/components/security/src/egress.dataplane.spec.ts`；provider/shell 数据面白名单默认拒绝 |
| Credential Broker | 是 | 是 | 部分 | 部分 | `packages/components/security/src/vault.ownership.spec.ts`、`packages/agent/src/providers/dispatch.provider.spec.ts`；占位符在 fetch 边界解析，CLI model discovery 尚未统一接入 |
| AuditSink | 是 | 是 | 部分 | 部分 | `packages/components/security/src/audit.socket.spec.ts`、`audit.daemon.recovery.spec.ts`；显式 socket 可签名/封存，默认无 sink |
| Realm 多租户 | 是 | 是 | 部分 | 部分 | `packages/agent/src/facade.tenant.spec.ts`、`packages/agent/src/tenant/governance.spec.ts`；provider/事件/资源/配额隔离通过专测，默认单租户运行 |
| SessionStore | 是 | 是 | 是 | 是 | `packages/agent/src/session/{jsonl,sqlite}.store.spec.ts`、`store.conformance.spec.ts`；JSONL + SQLite 双后端、resume/fork/崩溃恢复 |
| Compaction/Offloader | 是 | 是 | 是 | 部分 | `packages/agent-framework/src/session/offload.t12.spec.ts`、`recap.spec.ts`；typed recap 六段、workspace:/// 取回、双阈值与 peak 生效，token peak 为同源估算 |
| Skills/Resources | 是 | 是 | 部分 | 部分 | `packages/agent/src/resources/registry.spec.ts`；skills 两个 profile 都有，prompts/themes registry 仅 local-full |
| MCP | 是 | 是 | 部分 | 部分 | `packages/agent/src/plugins/mcp/{protocol,transport,oauth-grant,plugin-projection,conformance}.spec.ts`；握手/OAuth/schema/双结果投影通过，默认不装配，真实 OAuth token endpoint 由宿主注入 |
| TUI/OpenTUI | 是 | 是 | 是 | 部分 | `packages/tui/src/{backend.contract,slots,runtime,pty,platform-matrix}.spec.ts*`；自定义 backend 接管、slots/keymap 热更新、虚拟滚动；本机仅 win32 PTY 可跑，macOS/Linux 分支由状态机+测试覆盖 |
| CLI print/json/rpc | 是 | 是 | 是 | 部分 | `apps/zeta-cli/src/{headless-isolation,print-e2e}.spec.ts`、`packages/deploy/src/rpc.spec.ts`；RPC session control 为内存实现，真实 SessionStore 适配器可注入 |
| Deploy local/daemon/remote | 是 | 是 | 部分 | 部分 | `packages/deploy/src/{daemon,remote,rpc,artifact,canonical,runtime-probes,grpc}.spec.ts`；daemon HTTP/token/heartbeat 与 remote SDK 真实可运行；默认 remote 仍是 HTTP JSON-RPC + gRPC 风格状态码；`packages/deploy/src/grpc.ts` 已有真实 wire-level gRPC server/client 组件，但完整 gRPC 控制面/remote 拓扑未完成（T-24 后续），A30 不写 pass |
| Research/Promotion/Fitness | 是 | 是 | 否 | 部分 | `packages/agent/src/research/{frozen,promotion,guardrails,experience-library,fitness}.spec.ts`、`packages/deploy/src/fitness.budget-identity.spec.ts`；四道护栏与 A/B/回归门禁有独立 profile 专测，但证据库持久不可变、真实 effect span/OTLP 与两轮研究闭环（AC-22/T-22）未完成，默认不装配；不写“验收通过” |
| Observability | 是 | 是 | 部分 | 部分 | `packages/components/observability/src/index.spec.ts`、`packages/agent/src/facade.a21a22.spec.ts`；logger/redactor 与 fiber 归因存在，OTLP 故障降级与 effect 树全量接线仍为 seam |

## 机器可读装配清单（A39 自动一致的依据）

下列 JSON 由 `scripts/check-capability-matrix.mjs` 与 `packages/agent/src/assembly/builtins.ts` 的 `builtinIdsForProfile()` 逐项比对；修改 builtin 注册表后必须同步本块，否则 A39 失败。

```json
{
  "basis": "packages/agent/src/assembly/builtins.ts",
  "profiles": {
    "local-safe": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "session:store",
      "skills:registry"
    ],
    "local-full": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "service:prompts:registry",
      "service:resources:watcher",
      "service:themes:registry",
      "session:store",
      "skills:registry"
    ],
    "daemon": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "service:prompts:registry",
      "service:resources:watcher",
      "service:session:control",
      "service:themes:registry",
      "session:store",
      "skills:registry"
    ],
    "remote": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "service:prompts:registry",
      "service:resources:watcher",
      "service:session:control",
      "service:themes:registry",
      "session:store",
      "skills:registry"
    ],
    "research": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "service:prompts:registry",
      "service:resources:watcher",
      "service:themes:registry",
      "session:store",
      "skills:registry"
    ],
    "multi-tenant": [
      "builtin:bash",
      "builtin:edit",
      "builtin:find",
      "builtin:grep",
      "builtin:ls",
      "builtin:powershell",
      "builtin:read",
      "builtin:write",
      "mode:interactive",
      "mode:json",
      "mode:print",
      "mode:rpc",
      "service:prompts:registry",
      "service:resources:watcher",
      "service:session:control",
      "service:themes:registry",
      "session:store",
      "skills:registry"
    ]
  }
}
```

## 目标状态与已知缺口

完整系统要求上表所有“否/部分”项在对应阶段变为“是”，并满足以下约束：

- 默认 profile 可以保持安全收敛，但不得以占位实现掩盖未完成能力。
- 研究轨、daemon/remote、跨进程对象默认禁用，但必须真实实现并通过独立 profile 验收；启用路径不可绕过护栏。
- 任何“验收通过”都必须对应公共 API、端到端场景和可复现证据，不能只引用组件测试名称。

当前未闭环项（按事实保留，不计 pass）：

| 缺口 | 现状（2026-11-26） | 处理 |
| --- | --- | --- |
| 完整 gRPC 控制面/remote 拓扑 | `packages/deploy/src/grpc.ts` 已有真实 wire-level server/client 组件；默认 remote 仍 HTTP JSON-RPC，完整拓扑未接线 | A30 不写 pass；组件存在 ≠ 默认启用 ≠ 验收通过；由 T-24 及后续任务补齐 |
| 非宿主 target 运行态 | T-24 已把构建矩阵与运行矩阵分开：本机 12 target cross-build/static 逐项校验通过，运行证据为 1 native（win32-x64 真实启动/探针）+ 11 emulated（基于真实 embedded bytes 重放启动门禁，非 native）；CI 拆为 build-matrix 与 run-matrix | A36 不写 pass；emulated/skipped 均不冒充 native pass，非宿主 native 运行仍由 CI 宿主 job 覆盖 |
| release-age | 3 个直接依赖发布不足 7 天（historical，2026-11-25 裁决） | 如实记录为已知风险，未改阈值；本轮任务列表止于 T-25，无 T-26，后续窗口待评估 |
| 系统级 sandbox backend | local-full 的 shell.start 由真实进程执行器支撑并声明 active；isolation/seccomp 仍 unsupported（Windows 平台受限），插件隔离子进程无系统级 seccomp/jail。T-24 权威探针：无进程内沙箱 API、0 个 native addon、Job Object 仅能经 PowerShell 进程外 P/Invoke 且不限制 fs/network、无 AppContainer 打包身份；WSL 发行版存在但不属于当前宿主生产路径 | 保持系统沙箱失败关闭，不写 active/pass；F-T12-01 已由 local-full 真实 shell 关闭；F-T13-01 维持未关闭（closure=unmet），证据见 reports/sandbox-feasibility.md，交 T-25 如实列出 |
| 证据 v2 当前可复现性 | v2 契约冻结（T-01），当前基线尚未重跑全量 acceptance | 不宣称当前 40/40；须绑定 `develop@af37607` 与三平台 39/39 证据后重跑 |
