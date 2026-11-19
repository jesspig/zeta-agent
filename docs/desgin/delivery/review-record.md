# 设计文档集审查记录（2026-11-20）

> 文档定位：记录一次全面审查的发现与修复状态，供后续维护与二次审查对照。
> 所属索引：[delivery/README.md](./README.md) · [总索引](../README.md)

## 1 审查范围与方法

- **范围**：全部 32 个 Markdown（根 README + 6 目录 README + 25 内容文档）。
- **方法**：① 独立审查代理逐篇通读（颗粒度 / 概念边界 / 内部矛盾 / 交叉引用 / 规划可执行性五维）；② 机械脚本校验（模板一致性、术语计数、链接文字章节号 vs 目标、README 清单覆盖）。两路交叉验证。

## 2 已修复（P0 阻断开工）

| ID | 问题 | 修复 |
| --- | --- | --- |
| P0-1 | FiberState 类型 6 态 vs 状态图 5 态 vs 实现用不存在的 INACTIVE | core-semantics §3.2/§7.1/§7.2/§7.3、framework/README 状态机图、api-and-testing 统一为 6 态（PENDING/LOADING/ACTIVE/UNLOADING/FAILED/DISPOSED）；卸载回 PENDING，O-Remove 进 DISPOSED |
| P0-2 | View 类型声明存 Impl 但 targetOf 存 uid、UML 图写 FiberId | core-semantics `targetOf` 改存 Impl；components.md UML View/Impl 类图更正 |
| P0-3 | Entry 字段未同步 cordis 官方校正 | components.md §8.1/§8.2/UML 改为 name / 按服务 isolate 字典 / group.config / JsExpr；废弃 url/children |
| P0-4 | security/observability 依赖的 api.capabilities/onEffect/addRedactor 在 AgentPluginApi 不存在 | runtime.md §3.4 补三方法与 Capabilities/LayerState 类型，明确 defineServicePlugin 契约 |

## 3 已修复（P1 应修）

| ID | 问题 | 修复 |
| --- | --- | --- |
| P1-1 | 索引仍写阶段 0-5 / A1-A15 | 全文同步为阶段 0-6 / A1-A30 |
| P1-2 | 四层/L1-L4 旧模型残留 | framework-model §1.1/§13、roadmap §1、engineering §10/§11 统一为"两框架+应用形态"；其他语境的"四层纵深防御/配置/env"保留 |
| P1-3 | UML 类图写 9 kinds | runtime.md 改 10 kinds，并注明与 cordis 11 内部事件、coding-agent 40+ ExtensionEvent 的边界 |
| P1-5 | O-9 维度混淆 + 状态不一致 | roadmap §6 权限风险改指 fact-registry C5；根 README 标注 O-9 为"待用户确认的建议"，区分权限维度与发射交付维度 |
| P1-6/8 | dsh-optimizations 残留 @mode 与 backup 旧结论 | 文件头加"后续校正"块，指向 cordis 官方验证；保留历史记录时序 |
| P1-7 | cordis-source-verification §6/§7 状态标记过时 | 改为"已落地"+ VFS/env/7-case 列为阶段 5+ 待办 |
| P1-9 | 含 `+` 标题的锚点 slug 渲染器差异 | 改标题去 `+`（"两框架与应用形态"、"OpenTUI 与 SolidJS"）并同步 18 处引用 |
| P1-10 | 8 处错误链接 / 30 处章节号错指 | 批量修：§8-16 引用从 theory 篇改指 system 篇（22 处）；overview 错指改指细节文档（8 处）；AGENTS/langgraph 等错链修正 |
| P1-11 | 类型骨架签名不一致 | execute 改接收已解析 Effect（4 形态）；Component.apply 返回 Effect；effect 加 label 重载；测试包名统一 @zeta-agent/testing |
| P1-12 | A1-A24 未覆盖新能力 | 新增 A25-A30（类型可编译/压缩正确性/经验检索/多租户/评测/部署三态） |
| P1-14 | facade exports 未声明使用的子路径 | overview §2 补 group/include/objects/store/testing 子路径声明 |

## 4 未完全处理（P1/P2，不阻断阶段 0-1）

| ID | 遗留 | 处理建议 | 优先级 |
| --- | --- | --- | --- |
| P1-4 | §5.2 pi 兼容 11 步伪代码 vs inbox+step 事件图两套 loop 模型未映射 | 阶段 1 落地时补映射表（inbox 组件 ↔ pi 10 事件） | P1 |
| P1-13 | B0-B3/C0-C3/阶段 0-6 四套批次无映射；部分 DSH 建议（AgentHandle/surface/ConversationNode/boot graph）未落地正文 | 建"建议 ID → 阶段 → 目标文档"映射表；未落地项标延期 | P1 |
| P2-1 | 6 个新文档模板与其余 20 个不统一 | 统一元信息块 + 文档关系表；overview/README 的重复 UML 改引用 | P2 |
| P2-2 | 研究文档建议表残留 03/04/05 旧编号 | 替换为文档名+锚点 | P2 |
| P2-3 | 总览过简（overview 36-48 行）、细节膨胀（core-semantics 330 行） | 总览加"本文档 vs 细节文档范围表" | P2 |
| P2-4 | capability-reservation 把 agent/assistant-stream 列为"已预留"（实为建议） | 改为"建议预留" | P2 |
| P2-5 | 两个"47 条"指代不同集合 | 命名区分（DSH 47 / 预留 47） | P2 |
| P2-6 | O-2/O-3/O-5/O-6/O-8 未进 roadmap §7 | 补齐或声明已并入 | P2 |
| P2-7 | 根 README 交付状态数字不可核验 | 改为可验证的链接检查结果 | P2 |

## 5 复核结果

- 机械校验：32 文件 / 703 链接 / 0 断链 / 0 断锚 / 0 章节错指 / 0 旧数字残留。
- 结论：P0 全部修复，阶段 0-1 的开工阻断已消除；P1/P2 剩余项为文档打磨，可在开发并行处理。

**总索引**：[README.md](../README.md)
