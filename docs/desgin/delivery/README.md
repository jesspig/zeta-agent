# 交付与验收（delivery）

> **目录定位**：从设计到代码的**实施路线、批次、验收判据、风险回滚**。本目录回答"按什么顺序做、做到什么程度算完成"。
> **所属索引**：[总索引](../README.md)　|　**依据**：[architecture](../architecture/README.md) + 全部设计文档

## 文档清单

| 文档 | 内容 | 粒度 |
| --- | --- | --- |
| [roadmap.md](./roadmap.md) | 迁移策略、阶段 0-6、关键路径、验收 A1-A30、HMR、风险与开放问题 | 实施路线 |
| [review-record.md](./review-record.md) | 全面审查记录：P0/P1/P2 发现与修复状态、复核结果 | 质量记录 |

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

## 跨目录关系

- 上游：[architecture/engineering.md](../architecture/engineering.md) 的验收标准；[research](../research/README.md) 的元理论判据。
- 验收对象：[framework](../framework/README.md)、[agent-framework](../agent-framework/README.md)、[agent](../agent/README.md)。

## 深度差距分析与本批处置（2026-11-23）

> 本节交付状态与代码现实对齐的方法论结论；具体 finding、处置流水与证据见执行文档（不在版本库内）。阶段 0-6 主体能力已实现并通过全量测试（849 pass / 0 fail；此前规划基线 734，第二阶段补齐后实测 849，数字以实测为准）。

### 六类差距结论

| 类别 | 差距结论 | 本批对应动作 |
| --- | --- | --- |
| 架构边界 | facade 依赖方向与 `exports` 子路径声明不完整，应用对组件包的直接依赖缺少守护 | **facade 归位**：补齐 facade 出口与子路径声明，架构守护脚本纳入 `bun run check` |
| 内核接口 | effect / coefficient / fiber 内核接口与 facade 表面未完全对齐，组件可替换性缺少验证 | 对齐内核接口与 facade 出口，保持组件包独立可测、可替换 |
| 工具流水线 | pi 基线中的 hook 字段赋值尚未升级为插件管线，monkey-patch 链仍是重构首要目标（见 [pi-baseline.md](../research/pi-baseline.md)） | **插件管线**：以插件管线替代字段赋值，保留 legacy 兼容层 |
| 安全接线 | 权限门禁、发射策略（withhold / enqueue）、egress 默认拒绝、凭证不持明文、进程外审计尚未端到端接线（见 [security.md](../agent/security.md)） | **权限 / 发射 / egress / 凭证 / 审计接线**：按契约逐项落地门禁与审计完整性 |
| TUI seam | 唯一发布实现与可替换后端 seam 的边界须在文档与实现两侧同时成立（见 [tui.md](../agent/tui.md)） | 保持 `RendererBackend` seam 与 `createTui({ backend })`，OpenTUI 仍为默认且唯一发布实现 |
| 阶段 5/6 | HMR 核心与 unit 快照恢复、对象运行时最小集、研究轨护栏均已实现并测试；此前交付文档存在失实表述 | **文档纠偏**：状态描述与代码现实对齐，延后项按设计边界重新界定 |

### 本批处置范围（固本与门禁）

- **固本**：facade 归位、插件管线、内核接口对齐、安全接线（权限 / 发射 / egress / 凭证 / 审计）。
- **门禁**：测试去伪（消除循环论证，确保不变量 legacy/plugin 双版行为独立性）、架构守护脚本、链接守护脚本 `scripts/check_docs_links.mjs`（0 断链 / 0 断锚）。
- **文档纠偏**：交付状态、索引与差距记录同步；不改动 [roadmap.md](./roadmap.md) 的阶段编号与验收语义。

### 明确延后（不在本批范围）

- **HMR / 对象运行时 / 研究轨护栏**：均已实现并测试；HMR unit 快照恢复见 `packages/components/loader/src/hmr.spec.ts`，对象运行时最小集见 `packages/framework/src/objects/`，研究护栏见 `packages/agent/src/research/guardrails.spec.ts`。
- **对象运行时延后项**：IPC / WS / SQLite / group commit / outbox / host / facet / Reference / rollout 按设计不实现。
- **研究轨边界**：promotion / experience / fitness 与四道护栏均为可选 seam，不进入默认装配，默认仍为 no-op seam；仅在具备可重放任务与评估器时启用。
