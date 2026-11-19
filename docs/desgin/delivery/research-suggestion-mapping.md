# 研究建议批次到阶段与任务映射表

> 目的：关闭 `review-record.md` P1-13 与 NFR-09——每个研究建议批次都有承接阶段、任务与目标文档，未落地项显式标延期。
> 范围：B0-B3（DSH）、C0-C3（能力预留）、SE（递归自演化）、CT（上下文压缩）、AS（AgentScope）、CR（CrewAI）、LG（LangGraph）。
> 约定：本表只做映射，不修改 `SPEC/PLAN/GRAPH`；产品轨第一版不实现自动代码生成与部署，研究轨仅预留 seam。

## 批次映射

| 批次 | 内容摘要 | 承接阶段 | 承接任务 | 目标文档 | 验收 |
| --- | --- | --- | --- | --- | --- |
| B0（架构前） | CORE-1/2/5/6、ENG-1/2、CORE-14、SUP-1/2 | ST-02、ST-03 | T-04、T-05、T-06、T-07、T-09 | `framework/core-semantics.md`、`framework/overview.md` | A3、A5、A6 |
| B1（框架实现） | CORE-3/4/7/8/9/10/11/12/16、ENG-4/5/10/12/13、SUP-3/4/5/8/9/10/12/13 | ST-04、ST-05、ST-06 | T-10、T-11、T-12、T-13、T-14、T-15、T-16 | `framework/core-semantics.md`、`agent-framework/runtime.md`、`agent-framework/tools-and-policies.md` | A6、A11、A13 |
| B2（UI 与体验） | ENG-7/8/9、ENG-11/15/16、CORE-13/15、SUP-6/7/15 | ST-09 | T-27 | `agent/tui.md` | A9、A10 |
| B3（后续） | ENG-6/14、SUP-11/14 | — | — | `research/dsh-optimizations.md` §6 | 延期，视裁决 |
| C0（P0 L1） | Channel/Snapshot/durable step/scopePath/writeSortKey + 事件信封与 Transformer 注册点 | ST-02、ST-03 | T-05、T-06、T-08、T-09 | `framework/core-semantics.md`、`framework/overview.md` | A3、A4 |
| C1（P1 L2） | Decision union / WorkUnit / HITL interrupt / AgentRuntime / stream part / NodeOptions | ST-05、ST-06 | T-13、T-15、T-16、T-17 | `agent-framework/runtime.md`、`agent-framework/state-and-events.md` | A6、A13 |
| C2（seam 与插件层） | Memory/Store/RAG/Orchestration/Backend 的 seam + no-op Provider | ST-09、ST-10 | T-25、T-30 | `framework/api-and-testing.md`、`agent/plugin-system.md` | A16-A20、A27 |
| C3（仅参考） | RPC 线协议、SOP 形态只进文档草案 | — | — | `research/capability-reservation.md` §6 | 延期，不实现 |
| SE 预留 | SE-H1/H13/H14/H15、SE-D2/D3 的接口定义 | ST-09、ST-10 | T-25、T-30 | `agent/plugin-system.md` §8 | A16-A20，seam 不进默认装配 |
| SE 研究轨 | SE-D1/D4/D5/D6/D10、SE-H2/H4/H6/H9/H10 | ST-10 | T-30 | `research/recursive-self-evolution.md` §6 | A16-A20、A27，按阶段验收 |
| SE 护栏 | SE-D7/D8/D11、SE-H3/H8/H11/H12、SE-H16 | ST-07 | T-21 | `agent/security.md` | A22、A23 |
| CT | CT-1..CT-12：双阈值/typed recap/压缩事务/血缘/屏障/旁路 metric/选择性读取/HUD | ST-07、ST-08、ST-09、ST-10 | T-19、T-22、T-23、T-24、T-27、T-29 | `agent/plugin-system.md` §5.1、`framework/observability.md`、`agent/tui.md` | A26、A29 |
| AS | AS-1..AS-14：决策 union/节点协议/流式事件/中间件/权限/Workspace/Offloader/工具组 | ST-05、ST-06、ST-07、ST-08 | T-13、T-15、T-16、T-17、T-18、T-20、T-22 | `agent-framework/runtime.md`、`agent-framework/tools-and-policies.md`、`agent/security.md` | A6、A9、A22、A26 |
| CR | CR-1..CR-17：typed seam/拦截点/事件因果/handler 图/WorkUnit/guardrail/工具失败/编排 | ST-03、ST-06、ST-09、ST-10 | T-07、T-08、T-16、T-18、T-25、T-30 | `framework/overview.md`、`agent-framework/tools-and-policies.md`、`agent/plugin-system.md` | A6、A13、A16-A20 |
| LG | LG-1..LG-16：Channel/Reducer/Snapshot/durable step/scope/写序/Store coeffect/中断恢复/流式块 | ST-02、ST-05、ST-07、ST-08 | T-04、T-06、T-14、T-15、T-19、T-24 | `framework/core-semantics.md`、`agent-framework/runtime.md`、`agent-framework/state-and-events.md` | A3、A4、A21、A24 |

## 延期项

| 建议 | 原因 | 处理时机 |
| --- | --- | --- |
| B3（ENG-6/14、SUP-11/14） | 非首版关键路径，依赖部署与性能基线稳定 | ST-10 后视裁决 |
| C3（RPC 线协议、SOP 形态） | 仅参考，不进入默认装配 | 仅文档草案，不实现 |
| SE 研究轨完整实现 | 需要可重放任务与评估器，产品轨第一版不做自动代码生成 | ST-10 后可选 |
| AS-13/14、CR-17、LG-16 | L3/L4 仅参考（SOP、服务层实体、遥测插件、RPC 线协议） | 仅文档，不实现 |
| O-4（Bun ESM 缓存驱逐实测） | 环境实测未完成 | T-13 前 |
| O-9（发射默认策略 withhold/direct） | 需用户确认 | T-21 装配前 |
