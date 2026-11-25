# RED 套件 needs-fixture 清单（T-02）

本清单记录**不能用当前生产 API 真实表达**的候选反例。它们不计入 RED 数量，也不写假失败。
每个条目给出：目标判据、当前代码事实、为什么不能作为可执行 RED、需要什么夹具/API。

| ID | 目标 | 当前代码事实 | 不能作为可执行 RED 的原因 | 需要的夹具/API |
| --- | --- | --- | --- | --- |
| NF-01 | AC-08 模型工具 schema 真实 | `packages/agent/src/facade.ts:1265-1271` 对 plugin/loadout 工具硬编码 `parameters: []` | `PluginTool`（`packages/agent-framework/src/plugins/types.ts:4-7`）没有 schema/parameters 字段，调用方无法声明期望 schema；写一个“期望非空 schema”的断言只能证明类型缺失，不能证明具体 schema 被吞掉 | 先扩展 `PluginTool`/`PluginContribution` 的 schema 声明入口，再对声明过的 schema 做投影断言 |
| NF-02 | AC-11 每跳重定向重验 egress、跨 origin 去凭证 | `packages/components/security/src/egress.ts:121-127` 只校验初始 URL，然后直接把 `input/init` 交给底层 `fetch` | 注入的 fake fetch 不会真的跟随 30x，无法在门禁边界观察第二跳；用真实 fetch 又需要网络/凭证夹具 | loopback HTTP 夹具返回 30x → 非白名单 host，且在 second hop 注入凭证探针；断言被拒且 Authorization/Cookie 不跨 origin |
| NF-03 | A30 完整 gRPC 控制面 / remote 拓扑 | `packages/deploy/src/grpc.ts` 已有真实 wire-level server/client；默认 remote 仍走 HTTP JSON-RPC | 组件已存在，但“完整控制面”没有稳定公开入口，无法用当前 API 表达一个可失败的完整性断言 | 需要 remote topology 公开 profile/seam 与可执行控制面场景；由 T-24 及后续任务提供 |
| NF-04 | A35 真实隔离执行器（shell/sandbox） | `packages/components/security/src/backend.*.ts` 全平台声明 unsupported，失败关闭 | 没有真实 backend 可注入，任何“隔离执行成功”断言都会因缺少实现而失败，属于缺失能力而非可运行反例；当前失败关闭行为本身是预期 | 需要真实进程/VM 隔离 backend 与逃逸探测夹具；由 T-13 提供 |
| NF-05 | A36 12 target 运行态证据 | CI `release-matrix` 36 job 只 build + `gate-platform` 静态校验；仅原生宿主跑生命周期 | 当前环境只有 win32-x64 宿主，无法在本机真实执行其余 11 target 的 install/start/upgrade/rollback | 三平台 runner + 12 target 原生产物与生命周期冒烟；由 T-24 提供 |
| NF-06 | AC-01 acceptance v2 当前 40/40 可复现 | T-01 已冻结 v2 契约（`scripts/evidence-v2-format.md`），但当前分支尚未重跑全量 acceptance | 缺少绑定 `develop@af37607` 且包含 CI 验真证据的本次运行报告；不能把历史 40/40 当作当前结论 | 需要 `--ci-evidence` 指向三平台 39/39 的真实运行 JSON 后执行 `bun scripts/acceptance-report.mjs` |

> 注意：NF-03/04/05/06 是**未完成能力/证据**，不是“通过”。它们的存在是为了防止把组件存在误写成验收通过。
