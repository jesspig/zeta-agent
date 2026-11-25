# 交付与验收（delivery）

> **目录定位**：从设计到代码的**实施路线、批次、验收判据、风险回滚**。本目录回答"按什么顺序做、做到什么程度算完成"。
> **所属索引**：[总索引](../README.md)　|　**依据**：[architecture](../architecture/README.md) + 全部设计文档

## 文档清单

| 文档 | 内容 | 粒度 |
| --- | --- | --- |
| [roadmap.md](./roadmap.md) | 迁移策略、阶段 0-6、关键路径、验收 A1-A40、HMR、风险与开放问题 | 实施路线 |
| [capability-matrix.md](./capability-matrix.md) | 公开能力的组件/显式注入/默认启用/验收四态矩阵，含机器可读装配清单 | 现状基线 |
| [review-record.md](./review-record.md) | 全面审查记录：P0/P1/P2 发现与修复状态、复核结果 | 质量记录 |
| [release-runbook.md](./release-runbook.md) | 安装/升级/回滚、发布校验、平台矩阵与已知限制 | 发布运维 |
| `scripts/acceptance-report.mjs` | 运行后生成 A1–A40 逐项 pass/fail、命令与证据路径 | 验收生成器 |
| `scripts/release-check.mjs` | 运行后生成版本、架构、SHA-256、SBOM、迁移/回滚校验 | 发布生成器 |

## 活动图（实施批次）

```mermaid
flowchart TD
    S0[阶段0: 工程骨架] --> S1[阶段1: framework 内核组件]
    S1 --> S2[阶段2: agent-framework 运行时]
    S2 --> S3[阶段3: agent 插件集]
    S3 --> S4[阶段4: TUI + CLI 装配]
    S4 --> S5[阶段5: HMR / 对象运行时 / 自演化护栏]
    S1 -.验证.> V[汇合性 / 可逆性 / guard 测试]
    S2 -.验证.> W[12 条不变量等价测试]
    S3 -.验证.> X[工具热插拔 / 权限热更新]
    S4 -.验证.> Y[帧快照 / 无 TTY 模式]
```

## 验收判据速查

| 判据 | 内容 | 来源 |
| --- | --- | --- |
| A1 | build/typecheck/test 全绿；lockfile；依赖图无环 | engineering.md |
| A3 | 同配置不同顺序 → 相同观察状态（Thm 80） | cordis-paper-system.md |
| A6 | 12 条不变量的 legacy/plugin 双版测试全绿 | pi-baseline.md |
| A9 | testRender 帧快照覆盖主要交互 | tui.md |
| A13-A15 | 事件 mode / patch 分层 / effects 幂等 | dsh-optimizations.md |
| A16-A20 | 冻结重放、晋升单调、观察等价、无 ground truth 泄漏 | recursive-self-evolution.md |
| A21-A30 | 可观测、隔离、egress/审计、类型/压缩/检索/租户/评测/部署 | 各专题设计文档 + [roadmap.md §4](./roadmap.md#4-验收标准) |
| A31-A40 | 依赖图、无 stub、崩溃恢复、并发边界、平台矩阵、conformance、性能门、文档一致、研究护栏 | [roadmap.md §4](./roadmap.md#4-验收标准) + `bun scripts/acceptance-report.mjs` |

## 跨目录关系

- 上游：[architecture/engineering.md](../architecture/engineering.md) 的验收标准；[research](../research/README.md) 的元理论判据。
- 验收对象：[framework](../framework/README.md)、[agent-framework](../agent-framework/README.md)、[agent](../agent/README.md)。

## 深度差距分析与本批处置（2026-11-23）

> 本节交付状态与代码现实对齐的方法论结论；具体 finding、处置流水与证据见执行文档（不在版本库内）。当前基线为 `develop @ 3c2ec55`，全量 `bun test` 1419 pass / 1 skip / 0 fail / 286 files；默认装配、公共 API、端到端验收与平台矩阵以 [capability-matrix.md](./capability-matrix.md) 为准，生成报告位于被忽略的 `reports/`。

### 六类差距的当前处置结果（2026-11-25 复核）

| 类别 | 原差距 | 当前结果（证据见 [capability-matrix.md](./capability-matrix.md)） |
| --- | --- | --- |
| 架构边界 | facade 依赖方向与 `exports` 子路径声明不完整 | `scripts/check-facade-exports.mjs`、`scripts/guard-architecture.mjs` 纳入 `bun run check`，全绿 |
| 内核接口 | effect / coeffect / fiber 与 facade 表面未完全对齐 | provider/effect/guard 与 6 态状态机通过 `context.spec.ts`、`fiber.spec.ts`、`properties.spec.ts` |
| 工具流水线 | hook 字段赋值尚未升级为插件管线 | 统一 `createToolPipeline`（T-08），保留 legacy 兼容层，双版不变量 24 项全绿 |
| 安全接线 | 权限 / 发射 / egress / 凭证 / 审计未端到端接线 | T-09/T-14 已接线；默认 shell/sandbox 能力仍 unsupported 且失败关闭，不写 active |
| TUI seam | 唯一发布实现与可替换后端边界 | `RendererBackend` + `createTui({ backend })` 可接管完整交互；OpenTUI 仍为默认且唯一发布实现 |
| 阶段 5/6 | HMR / 对象运行时 / 研究轨此前失实 | T-15/T-18/T-19/T-24/T-25 已实现并通过专测；默认装配边界按能力矩阵描述 |

### 当前范围与门禁（2026-11-25）

- **已落地**：facade 归位、插件管线、内核接口、安全接线、真实 HMR、对象运行时（host/facet/Reference、SQLite/WAL/outbox、IPC/WS、jobs/derive/rollout）、MCP 协议、三态部署、研究轨护栏。
- **持续门禁**：测试去伪棘轮、架构守护、链接守护（0 断链 / 0 断锚）、质量门（`bun run gates`：43 pass / 11 skipped / 1 unverified）。
- **验收口径**：`bun scripts/acceptance-report.mjs` 逐项记录 A1–A40 的 pass/fail；A30 已补齐真实 gRPC 并转 pass，A36（11 个非宿主 target）仍如实记 fail/待 CI 补证，不写 pass。

### 后续阶段边界

- **默认 profile**：`local-safe` 收敛、`local-full` 显式 opt-in；研究轨、daemon/remote、跨进程对象默认禁用，启用路径不可绕过护栏。
- **对象运行时**：IPC 使用 worker_threads（非 OS 子进程），WS 为 loopback；完整跨主机拓扑与真实隔离执行器属于后续平台阶段。
- **发布平台**：本机仅 win32-x64 完成安装/启动/升级/回滚冒烟，其余 11 target 由 CI 三平台矩阵覆盖，未在本机执行的部分一律 skipped。
