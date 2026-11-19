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
