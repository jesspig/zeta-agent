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
| P1-4 | ~~§5.2 pi 兼容 11 步伪代码 vs inbox+step 事件图两套 loop 模型未映射~~ **已关单** | 已补逐项映射表：[runtime.md §5.3](../agent-framework/runtime.md#53-pi-11-步与-inboxstep-机制映射表)（pi 11 步 ↔ inbox 双队列 / step 内部 hook / `AgentEvent`）；步骤 1 已条件化并由 `loop.spec.ts` 的 onStep 顺序断言覆盖 | P1（已关单） |
| P1-13 | B0-B3/C0-C3/阶段 0-6 四套批次无映射；部分 DSH 建议（AgentHandle/surface/ConversationNode/boot graph）未落地正文 | 建"建议 ID → 阶段 → 目标文档"映射表；未落地项标延期 | P1 |
| P2-1 | 6 个新文档模板与其余 20 个不统一 | 统一元信息块 + 文档关系表；overview/README 的重复 UML 改引用 | P2 |
| P2-2 | 研究文档建议表残留 03/04/05 旧编号 | 替换为文档名+锚点 | P2 |
| P2-3 | 总览过简（overview 36-48 行）、细节膨胀（core-semantics 330 行） | 总览加"本文档 vs 细节文档范围表" | P2 |
| P2-4 | capability-reservation 把 agent/assistant-stream 列为"已预留"（实为建议） | 改为"建议预留" | P2 |
| P2-5 | 两个"47 条"指代不同集合 | 命名区分（DSH 47 / 预留 47） | P2 |
| P2-6 | O-2/O-3/O-5/O-6/O-8 未进 roadmap §7 | 补齐或声明已并入 | P2 |
| P2-7 | 根 README 交付状态数字不可核验 | 改为可验证的链接检查结果 | P2 |

## 5 复核结果

- 机械校验：链接守护脚本实跑统计 34 文件 / 727 链接 / 486 锚点 / 0 断链 / 0 断锚（以 `bun scripts/check_docs_links.mjs` 输出为准）；另 0 章节错指 / 0 旧数字残留。
- 结论：P0 全部修复，阶段 0-1 的开工阻断已消除；P1/P2 剩余项为文档打磨，可在开发并行处理。

## 6 设计漂移修复轮（2026-11-20）

针对上一轮差距分析确认的 4 类漂移完成修复，文档与实现同步：

| 类别 | 修复 | 验收 |
| --- | --- | --- |
| TUI 栈 | OpenTUI 0.9.3 + SolidJS 落地为默认且唯一发布实现；公开 `RendererBackend` seam + `createTui({ backend })` 供用户自带后端；仓库无 StringBackend/替代后端 | AC-03 / AC-04 |
| facade 边界 | facade 包补 `exports` 子路径；架构守护脚本纳入 `bun run check`；两个聚合包从空壳填为真实出口 | AC-05 / AC-06 |
| PluginApi 接线 | `createAgent` 装配 `capabilities/onEffect/addRedactor`（仅委托）；A21/A22 经 facade 表面可达 | AC-07 |
| 工程收尾 | 根 README / index.ts 去除 bun init 残留；TUI 设计文档标注唯一实现 + 公开 seam；overview 标注 exports 落地状态 | AC-09 / AC-10 |

- 零回归：核心语义既有测试全绿（234 → 253 pass，0 fail）；全量 `bun run build/typecheck/test` 与 `tsc --noEmit` 全绿。
- 链接复核：`scripts/check_docs_links.mjs`（GitHub slug 规则）实跑统计 34 文件 / 727 链接 / 486 锚点 / 0 断链 / 0 断锚（以 `bun scripts/check_docs_links.mjs` 输出为准）；修复了 8 处历史遗留错锚（跨文档章节号误用纯锚点）。
- 历史归档：上一轮 `.handoff` 快照只读保留于 `.handoff/archive/2026-11-20-1659-zeta-agent-harness/`（85 文件 + manifest）。

**总索引**：[README.md](../README.md)

## 7 审查闭环复审（2026-11-23）

> 本节记录复审归零结论。复审基线 HEAD `870c145`（旧 finding 修复均在此基线内），
> CR-39 修复提交 `183d990`、归并 `a6648f9`。**权威结论以本节为准**（受版本控制、可审计）；
> `.handoff/CODE_REVIEW.md` 与 `.handoff/reviews/` 内报告为过程产物（被 gitignore）。

### 7.1 复审结论

| 项 | 值 |
| --- | --- |
| review_id | `2026-11-23-1430-rereview-closure` |
| 复审基线 | `870c145`（46 条 finding 的修复均在此基线内） |
| 含 CR-39 修复的 HEAD | `a6648f9`（提交 `183d990` → 归并 `a6648f9`） |
| 级别 / 模式 | deep / precision |
| verdict | `approve` |
| standards_status | `pass` |
| spec_status | `available`（详见 7.3） |
| risk_status | `pass` |
| 本轮新 finding | 0 |
| 上一轮 finding | 47 条全部 closed：46 verified_fixed（含 CR-39），1 false_positive（补审 CR-07） |

- 复审报告：`review_id 2026-11-23-1430-rereview-closure`，scope=diff（870c145..a6648f9）、2 文件 / 2 单元；`render`/`validate --strict`/`publish` 均通过。
- 上一轮两份报告（首轮 deep-full、补审 supplemental-paths）保留历史，不直接篡改；本轮通过 memory pass 逐条对账处置。

### 7.2 CR-39 裁决

- **用户裁决：修复**（非接受风险）。
- **修复内容**：`packages/agent-framework/src/runtime/invariants.spec.ts` 将 legacy/plugin 两版共享的 `CHECKS(check(mode))` 拆为各 12 条自包含断言体，每条各自构造本版 runtime、内联行为断言与接线哨兵（`legacyHookProbe` / `pluginHookProbe`）；`scripts/check-invariant-points.mjs` 门 2 配套改为扫描 `cases` 的 legacy 断言体。
- **理由（消除循环论证）**：两版不再共享行为断言函数体；每条断言各自构造本版接线、各自断言可观察行为，哨兵仅证明本版接线被 runLoop 读取，**不替代**行为独立性证明。旧延期理由"以按 mode 哨兵断言替代行为独立"的自相矛盾已消除。
- **验证**：RED 25 pass / 1 fail（结构门失败，暴露共享 body）→ GREEN 26 pass / 0 fail；全量 849 pass / 0 fail；`bun run check` 45/45 + 要点关键词门通过；归并后主工作树复验通过。

### 7.3 spec 验收复核

- 对照 `delivery/roadmap.md §4`（A1-A30）与 `architecture/engineering.md §12` 复核。
- **核心质量门项通过**：
  - A1（build/typecheck/test 全绿、依赖图无环）：`bun run check` 45/45、全量 849 pass、依赖门通过。
  - A6（12 条不变量 legacy/plugin 双版 24 测试 + 双门）：24 个 `inv-core-` 测试全绿；门 1 哨兵与门 2 要点关键词门均通过；本轮 CR-39 修复进一步强化了两版独立性。
- 其余判据：A3/A4/A5/A13-A15/A21-A23/A26-A27/A29-A30 已有测试证据，A2/A14/A28 已由 T-07 补齐；其余为阶段 0-6 规划项，按 roadmap 路线推进。本轮不逐项判为 fail，标注"按阶段推进 / 待后续验收"。
- **结论**：验收矩阵可用，`spec_status` 由旧报告的 `fail` / `not_available` 更新为 `available`；核心质量门项通过，无 spec 验收失败导致的阻断。

### 7.4 handoff 状态一致性

- finding 计数、状态、下一步与偏离记录已在 `.handoff/STATE.md` 对齐：46 条 finding 全部 closed/verified_fixed + 1 条 false_positive；偏离 D-100..D-104 记录执行模式、顺序调整、worktree、质量门配套等。
- 旧报告与归档只读保留，未篡改历史。

### 7.5 零回归结果

| 检查 | 基线（T-00，HEAD 870c145） | 收口（T-06，含 CR-39 修复） | 结论 |
| --- | --- | --- | --- |
| `bun test` | 678 pass / 0 fail | 679 pass / 0 fail | 通过（+1 为 CR-39 结构门） |
| `bun run check` | 45/45 | 45/45 | 通过 |
| docs 链接 | 0 断链 / 0 断锚 | 0 断链 / 0 断锚 | 通过 |

零回归达成，数字不下降。证据见 `evidence/T-06/`。

## 8 深度差距分析与本批处置（2026-11-23）

> 本节保留 2026-11-23 深度差距分析的历史结论与处置边界。2026-11-24 起，完整系统执行计划不再以“阶段 0-6 主体完成”为终点；组件级测试结果保留，端到端验收以 [capability-matrix.md](./capability-matrix.md) 与完整执行文档为准。

### 8.1 六类结论

| 类别 | 差距结论 | 本批对应动作 |
| --- | --- | --- |
| 架构边界 | facade 依赖方向与 `exports` 子路径声明不完整，应用对组件包的直接依赖缺少守护 | **facade 归位**：补齐 facade 出口与子路径声明，架构守护脚本纳入 `bun run check` |
| 内核接口 | effect / coefficient / fiber 内核接口与 facade 表面未完全对齐，组件可替换性缺少验证 | 对齐内核接口与 facade 出口，保持组件包独立可测、可替换 |
| 工具流水线 | pi 基线中的 hook 字段赋值尚未升级为插件管线，monkey-patch 链仍是重构首要目标（见 [pi-baseline.md](../research/pi-baseline.md)） | **插件管线**：以插件管线替代字段赋值，保留 legacy 兼容层 |
| 安全接线 | 权限门禁、发射策略（withhold / enqueue）、egress 默认拒绝、凭证不持明文、进程外审计尚未端到端接线（见 [security.md](../agent/security.md)） | **权限 / 发射 / egress / 凭证 / 审计接线**：按契约逐项落地门禁与审计完整性 |
| TUI seam | 唯一发布实现与可替换后端 seam 的边界须在文档与实现两侧同时成立（见 [tui.md](../agent/tui.md)） | 保持 `RendererBackend` seam 与 `createTui({ backend })`，OpenTUI 仍为默认且唯一发布实现 |
| 阶段 5/6 | HMR 核心与 unit 快照恢复、对象运行时最小集、研究轨护栏均已实现并测试；此前交付文档存在与代码现实脱节的失实表述 | **文档纠偏**：状态描述与代码现实对齐，延后项按设计边界重新界定 |

### 8.2 本批处置范围（固本与门禁）

- **固本**：facade 归位、插件管线、内核接口对齐、安全接线（权限 / 发射 / egress / 凭证 / 审计）。
- **门禁**：测试去伪（消除循环论证，确保不变量 legacy/plugin 双版行为独立性）、架构守护脚本、链接守护脚本 `scripts/check_docs_links.mjs`（0 断链 / 0 断锚）。
- **文档纠偏**：交付状态、索引与差距记录同步；不改动 [roadmap.md](./roadmap.md) 的阶段编号与验收语义。

### 8.3 明确延后（不在本批范围）

- **HMR / 对象运行时 / 研究轨护栏**：均已实现并测试；HMR unit 快照恢复见 `packages/components/loader/src/hmr.spec.ts`，对象运行时最小集见 `packages/framework/src/objects/`，研究护栏见 `packages/agent/src/research/guardrails.spec.ts`。
- **对象运行时延后项**：IPC / WS / SQLite / group commit / outbox / host / facet / Reference / rollout 在 2026-11-23 批次中未实现；现已纳入完整系统后续阶段，不再作为永久不实现项。
- **研究轨边界**：promotion / experience / fitness 与四道护栏均为可选 seam，不进入默认装配，默认仍为 no-op seam；仅在具备可重放任务与评估器时启用。

### 8.4 2026-11-25 复核结论

- 上表 8.1/8.3 的“尚未升级 / 尚未接线 / 延后未实现”均为 2026-11-23 的历史口径；T-08/T-09/T-14/T-15/T-18/T-19/T-24/T-25 已逐项落地并通过专测，当前状态以 [capability-matrix.md](./capability-matrix.md) 为准。
- 安全维度仍保持失败关闭：无真实隔离执行器时 shell/seccomp 一律 unsupported；egress 默认拒绝；凭证不持明文；审计显式 sink 可签名/封存。
- 发布与平台：本机仅 win32-x64 完成安装/启动/升级/回滚；wire-level gRPC 已补齐并通过 A30，11 个非宿主 target 仍使 A36 fail，需 CI 三平台补证；逐项结论由 `bun scripts/acceptance-report.mjs` 生成。
