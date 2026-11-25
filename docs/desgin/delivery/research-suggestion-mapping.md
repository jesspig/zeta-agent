# 研究建议批次到阶段与任务映射表

> 目的：关闭 `review-record.md` P1-13 与 NFR-09——每个研究建议批次都有承接任务与当前状态，未落地项显式标待评估。
> 范围：B0-B3（DSH）、C0-C3（能力预留）、SE（递归自演化）、CT（上下文压缩）、AS（AgentScope）、CR（CrewAI）、LG（LangGraph）。
> 约定：本表只做映射，不修改 `SPEC/PLAN/GRAPH`；默认产品 profile 不启用自动代码生成与部署。
> **当前任务集**：本轮只有 T-01..T-25。旧文档中的 T-26/T-27/T-29/T-30 属历史计划编号，当前并不存在，已从本表全部移除；没有当前承接项的批次一律标“待评估”，不得假装已实现。

## 批次映射（当前任务集 T-01..T-25）

| 批次 | 内容摘要 | 本轮承接任务 | 目标文档 | 当前状态（四态） | 备注 |
| --- | --- | --- | --- | --- | --- |
| B0（架构前） | CORE-1/2/5/6、ENG-1/2、CORE-14、SUP-1/2 | T-03、T-04、T-06、T-07、T-09 | `framework/core-semantics.md`、`framework/overview.md` | 组件存在 + 显式可注入；默认部分启用 | 有专测，不等于 A3/A5/A6 当前验收通过 |
| B1（框架实现） | CORE-3/4/7/8/9/10/11/12/16、ENG-4/5/10/12/13、SUP-3/4/5/8/9/10/12/13 | T-03、T-04、T-05、T-08、T-10、T-11、T-14、T-15 | `framework/core-semantics.md`、`agent-framework/runtime.md`、`agent-framework/tools-and-policies.md` | 组件存在 + 显式可注入；默认部分启用 | T-12/T-13/T-16 仍为未完成能力（backend/真实隔离/daemon 完整拓扑） |
| B2（UI 与体验） | ENG-7/8/9、ENG-11/15/16、CORE-13/15、SUP-6/7/15 | T-23 | `agent/tui.md` | 组件存在；三平台真实 PTY 未完成 | A23 不写 pass，T-23 负责闭环 |
| B3（后续） | ENG-6/14、SUP-11/14 | 待评估（本轮无任务） | `research/dsh-optimizations.md` §6 | 仅文档建议 | 不实现，不标 pass |
| C0（P0 L1） | Channel/Snapshot/durable step/scopePath/writeSortKey + 事件信封与 Transformer 注册点 | T-03、T-04、T-06、T-09 | `framework/core-semantics.md`、`framework/overview.md` | 组件存在 + 显式可注入；默认部分启用 | 有专测 |
| C1（P1 L2） | Decision union / WorkUnit / HITL interrupt / AgentRuntime / stream part / NodeOptions | T-03、T-08、T-09、T-15 | `agent-framework/runtime.md`、`agent-framework/state-and-events.md` | 组件存在 + 显式可注入；默认部分启用 | 有专测 |
| C2（seam 与插件层） | Memory/Store/RAG/Orchestration/Backend 的 seam + no-op Provider | T-04、T-05、T-06、T-22；RAG/Orchestration 待评估 | `framework/api-and-testing.md`、`agent/plugin-system.md` | 部分实现；默认不启用 | seam 不等于完整实现；无当前任务的子项不标 pass |
| C3（仅参考） | RPC 线协议、SOP 形态只进文档草案 | 待评估（不实现） | `research/capability-reservation.md` §6 | 仅文档草案 | 不进入默认装配 |
| SE 预留 | SE-H1/H13/H14/H15、SE-D2/D3 的接口定义 | T-21、T-22 | `agent/plugin-system.md` §8 | 组件存在 + 显式可注入；默认不启用 | seam 不进默认装配 |
| SE 研究轨 | SE-D1/D4/D5/D6/D10、SE-H2/H4/H6/H9/H10 | T-21、T-22 | `research/recursive-self-evolution.md` §6 | 部分实现；默认禁用 | 两轮研究闭环与不可变证据库未完成（A22/T-22），不写“验收通过” |
| SE 护栏 | SE-D7/D8/D11、SE-H3/H8/H11/H12、SE-H16 | T-11、T-21、T-22 | `agent/security.md` | 组件存在 + 显式可注入；默认不启用 | 四道护栏有专测 |
| CT | CT-1..CT-12：双阈值/typed recap/压缩事务/血缘/屏障/旁路 metric/选择性读取/HUD | T-09、T-18 | `agent/plugin-system.md` §5.1、`framework/observability.md`、`agent/tui.md` | 部分实现；默认不启用 | 压缩只在 agent_end 改 surface，未投影到 provider 请求（A18/T-18 未完成） |
| AS | AS-1..AS-14：决策 union/节点协议/流式事件/中间件/权限/Workspace/Offloader/工具组 | T-03、T-08、T-09、T-12、T-15 | `agent-framework/runtime.md`、`agent-framework/tools-and-policies.md`、`agent/security.md` | 部分实现；默认部分启用 | 真实隔离/完整 Offloader 未完成 |
| CR | CR-1..CR-17：typed seam/拦截点/事件因果/handler 图/WorkUnit/guardrail/工具失败/编排 | T-07、T-08、T-15、T-21、T-22 | `framework/overview.md`、`agent-framework/tools-and-policies.md`、`agent/plugin-system.md` | 组件存在 + 显式可注入；默认部分启用 | 编排全链路未完成 |
| LG | LG-1..LG-16：Channel/Reducer/Snapshot/durable step/scope/写序/Store coeffect/中断恢复/流式块 | T-03、T-04、T-06、T-15、T-17 | `framework/core-semantics.md`、`agent-framework/runtime.md`、`agent-framework/state-and-events.md` | 组件存在 + 显式可注入；默认部分启用 | 双后端 conformance 由 T-17 闭环 |

## 待评估 / 延期项

| 建议 | 原因 | 处理 |
| --- | --- | --- |
| B3（ENG-6/14、SUP-11/14） | 非首版关键路径，依赖部署与性能基线稳定 | 本轮无对应任务，待评估 |
| C3（RPC 线协议、SOP 形态） | 仅参考，不进入默认装配 | 仅文档草案，不实现 |
| SE 研究轨完整实现 | 需要可重放任务与评估器，产品轨第一版不做自动代码生成 | T-22 后待评估，不写 pass |
| C2 的 RAG/Orchestration、AS-13/14、CR-17、LG-16 | L3/L4 仅参考（SOP、服务层实体、遥测插件、RPC 线协议） | 仅文档，不实现 |
| O-4（Bun ESM 缓存驱逐实测） | 环境实测未完成 | T-05 中待评估 |
| O-9（发射默认策略 withhold/direct） | 需用户确认 | 保持历史建议 withhold；未确认前不标默认启用 |
| 旧 T-26..T-30 引用 | 历史计划编号，当前任务集止于 T-25 | 已全部从本表移除；相关能力按 T-01..T-25 映射或标待评估 |
