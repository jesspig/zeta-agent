# 事实登记与交叉验证矩阵

> **文档定位**：事实登记与交叉验证矩阵（从 `09-事实登记与交叉验证矩阵.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [1 来源清单（按分级）](#1-来源清单按分级)
- [2 事实登记表](#2-事实登记表)
- [3 承重论断的双源验证](#3-承重论断的双源验证)
- [4 矛盾与争议（显式并列）](#4-矛盾与争议显式并列)
- [5 缺口与未验证项](#5-缺口与未验证项)
- [6 交叉验证矩阵（设计决策 ↔ 来源 ↔ 验证）](#6-交叉验证矩阵设计决策-来源-验证)
- [7 自检门结果](#7-自检门结果)

## 1 来源清单（按分级）

### 一手来源

| ID | 来源 | 类型 | 时点 | 说明 |
| --- | --- | --- | --- | --- |
| S1 | [arXiv:abs/2608.25512v1](https://arxiv.org/abs/2608.25512v1)（arXiv:2608.25512v1，92 页，Shi/Zhang/Cui） | 预印本原文 | 2026-08（编号），访问 2026-11-19 | 理论定义、定理、算法、实现描述均出自此；文献等级为预印本（二级学术来源），但作为本项目唯一直接论文来源按一手处理 |
| S2 | [earendil-works/pi · packages/chord](https://github.com/earendil-works/pi/tree/main/packages/chord) 源码与 `docs/*.md`（v1.5.2） | 源码 / 官方文档 | 仓库当前状态，2026-11-19 | chord 的 facet/registry/插件机械/数据模型 |
| S3 | [packages/agent](https://github.com/earendil-works/pi/packages/agent) 源码、`README.md`、`test/`（v1.5.2） | 源码 / 测试 | 同上 | agent-core 的 API、runLoop、不变量 |
| S4 | [packages/coding-agent](https://github.com/earendil-works/pi/packages/coding-agent) 源码与 `docs/*.md` | 源码 / 官方文档 | 同上 | ExtensionAPI、启动链、资源加载、模式 |
| S5 | [packages/tui](https://github.com/earendil-works/pi/packages/tui) 源码与 `README.md` | 源码 | 同上 | Component/TUI/差分渲染 |
| S6 | [packages/{ai,durable,schema,mcp,env,codemode,telemetry,evals}](https://github.com/earendil-works/pi/packages/{ai,durable,schema,mcp,env,codemode,telemetry,evals}) | 源码 | 同上 | 生态包职责与依赖 |
| S7 | [pi/README.md](https://github.com/earendil-works/pi/README.md)、`package.json`、`AGENTS.md` | 官方仓库文档 | 同上 | 包职责、供应链、构建顺序、打包约定 |
| S8 | `zeta-agent` 工作区的 `package.json`、`bun.lock`、`index.ts`（本项目自身，无上游仓库） | 本地工作区事实 | 2026-11-19 | bun init 空项目（bun 1.4.2、TS ^7） |
| S12 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（vendored Cordis + `docs/architecture.md` + `packages/*` + `vendor/cordis/src/*`） | 一手源码 / 官方文档 | 2026-11-19 | **Cordis 论文的生产级参考实现（只读复刻蓝本，非运行时依赖）**：`vendor/cordis/src/*` 对应我们通用框架的 `cordis` 组件；`packages/*` 对应其他组件/Agent 框架。**本项目不引入任何上游 Cordis 包**，`@zeta-agent/cordis` 为自研组件命名 |
| S13 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（`docs/000-008` + `src/core/*` + `src/app/{effects,outbox,store}.*` + `cordis.patch.yml`） | 一手源码 / 官方文档 | 2026-11-19 | 构建在 S12 之上的主动式 coding agent 研究原型，提供域模型、授权 Mandate、durable effects、preset patch 的组织级治理参考 |
| S14 | [agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope)（`src/agentscope/` 2.0） | 一手源码 | 2026-11-19 | 统一 Agent + middleware + AgentState；决策三态纯函数、节点协议同构、HITL park/resume、Workspace/Backend 三原语 |
| S15 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)（`lib/crewai/src/crewai/`） | 一手源码 | 2026-11-19 | 角色+委托工具+单一任务循环的多 agent；typed seam、FlowDefinition、guardrail、结构化工具失败 |
| S16 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)（`libs/`，HEAD `84ced60`） | 一手源码 | 2026-11-19 | LangGraph is a runtime；agent=StateGraph+2 节点+Send；Channel/Snapshot/checkpoint/interrupt/StreamTransformer |
| S17 | [google-research/dream-rsi](https://github.com/google-research/dream-rsi)（Apache-2.0） | 一手源码 | 2026-11-19 | 递归自我改进：只改单一决策文件 `method.py`；冻结 trace + Eq.1 适应度 + incumbent 单调晋升；统一 SearchEnv 决策面 |
| S18 | [google-research/harness2](https://github.com/google-research/harness2)（[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)，Apache-2.0） | 一手源码 | 2026-11-19 | 递归 harness 优化：8 组件可编辑配方树、Propose–Probe–Compose、无 ground truth、ExperienceReflector、三轴分离 |
| S19 | [cordiverse/cordis](https://github.com/cordiverse/cordis)（core `4.0.0-rc.13`） | 一手源码 | 2026-11-19 | **论文官方实现**：对照验证复刻设计，纠正 13 处错误/过简（@mode 不存在、HMR 按 unit 部分提交、撤销两层语义、6 态 FiberState）；非依赖，只读参考 |
| S20 | [opensandbox-group/OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) | 一手源码 | 2026-11-19 | 沙箱四层隔离、egress 默认拒绝、Credential Vault、进程外审计、守护进程拓扑；补缺口 4/7 |
| S21 | [coze-dev/coze-studio](https://github.com/coze-dev/coze-studio) | 一手源码 | 2026-11-19 | 生产级平台强项（错误码/部分失败/因果 log-id/执行历史）+ 反面教材（OTel 未埋点/默认 RCE/弱 ACL）；补缺口 2/3/8 |
| S22 | [anomalyco/opencode](https://github.com/anomalyco/opencode)（默认分支 `dev`） | 一手源码 | 2026-11-19 | 结构化日志/OTLP 降级/AIError 11 类/分层重试/ExecutionLimits/单文件二进制/性能基准；补缺口 2/6/7/8 |
| S23 | [arXiv:2603.28052](https://arxiv.org/abs/2603.28052) *Meta-Harness* | 论文预印本 | 2026-03 | coding agent 作 proposer + 全历史文件系统（10 MTok/iter、每轮读 82 文件）；Table 3 实证原始 traces 优于摘要；补 experience store 非马尔可夫检索缺口 |
| S24 | [arXiv:2611.05306](https://arxiv.org/abs/2611.05306) *You don't need long context* | 论文预印本 | 2026-11 | 后期 token 成本最高 7x（货币/吞吐，延迟约 2x）；频繁压缩几乎不损精度；SSSM 与 typed recap；补性能双阈值与会话压缩 |

### 权威二手 / 官方在线来源

| ID | 来源 | 类型 | 访问时点 | 说明 |
| --- | --- | --- | --- | --- |
| S9 | OpenTUI Docs（`opentui.com/docs`、`/bindings/solid/`、`/api/solid/`、`/plugins/solid/`） | 官方在线文档 | 2026-11-19 | `@opentui/solid` 0.9.3 API、slots、preload、`testRender` |
| S10 | npm `@opentui/solid` 页面（版本 0.9.3，更新 2026-11-18） | 官方包元数据 | 2026-11-19 | 版本、peer、依赖 |
| S11 | Turborepo Docs（`turborepo.dev/docs/crafting-your-repository/...`、`/configuring-tasks`、`/reference/configuration`） | 官方在线文档 | 2026-11-19 | Bun workspaces、`turbo.json`、`dependsOn`/`outputs`/`dev` 配置 |

### 弱来源（仅作线索，未支撑承重论断）

- 无。本次未采用论坛/自媒体作为事实依据。


## 2 事实登记表

> 断言列中的页码为 PDF 物理页；[pi/...](https://github.com/earendil-works/pi/...) 为本地源码路径。验证结论取四值之一：支持 / 部分支持 / 矛盾 / 无法验证。

| 断言 | 来源 | 类型 | 时点 | 置信 | 原文/转述 | 验证结论 |
| --- | --- | --- | --- | --- | --- | --- |
| Cordis 区分时间/空间可组合性，分别用可撤销 effect 与响应式 coeffect 解决 | S1 p.1, p.4-6 | 预印本原文 | 2026-08 | 高 | 原文 | 支持（[cordis-paper §2](../research/cordis-paper-theory.md#2-问题域为什么万物皆插件需要形式化)） |
| effect 模型为 `Γ→Γ×(Γ→Γ)`，逆只需单边 `g∘f`，累积器按 LIFO 组合 | S1 p.9-16 | 预印本原文 | 2026-08 | 高 | 原文（定义 1-18） | 支持（[cordis-paper §4](../research/cordis-paper-theory.md#4-可撤销效应revertible-effects)） |
| coeffect context 是依赖键到类型化值的偏函数；`set ∈ 𝔈*Σ`，coeffect 操作即 effect | S1 p.17-18 | 预印本原文 | 2026-08 | 高 | 原文（定义 19-22） | 支持（[cordis-paper §5](../research/cordis-paper-theory.md#5-响应式共效应reactive-coeffects)） |
| 统一上下文 `Γ∞=μΓ.Γ×(Γ→Γ)×Σ`；一切交互经上下文中介 | S1 p.21-23 | 预印本原文 | 2026-08 | 高 | 原文（定义 28-30） | 支持（[cordis-paper §6](../research/cordis-paper-theory.md#6-上下文范式context-paradigm)） |
| 恢复是观察等价下的恢复，不是物理状态还原 | S1 p.23-25 | 预印本原文 | 2026-08 | 高 | 原文（定义 31-37） | 支持（[cordis-paper §6.2](../research/cordis-paper-theory.md)） |
| 同键操作需可交换见证；不同键天然独立；有序链不可交换 | S1 p.28-30 | 预印本原文 | 2026-08 | 高 | 原文（定义 44-46、定理 45/47） | 支持（[cordis-paper §7.2](../research/cordis-paper-theory.md)） |
| 九条规则 + target/committed view + guard；唯一施加累积器的规则是 L-Unload | S1 p.31-40 | 预印本原文 | 2026-08 | 高 | 原文（定义 48-56、表 1） | 支持（[cordis-paper §8](../research/cordis-paper-system.md#8-动态组合演算组件与-fiber)） |
| Thm 68/69/70/71/73/80 构成全局保证（恢复、撤回顺序、解析一致、静止、汇合） | S1 p.43-55 | 预印本原文 | 2026-08 | 高 | 原文（定理陈述） | 支持（[cordis-paper §9](../research/cordis-paper-system.md#9-元理论五条承重保证)） |
| `ctx.effect` 是所有上下文变更的唯一入口；不验证 witness | S1 p.59（算法 1） | 预印本原文 | 2026-08 | 中高 | 原文 | 支持（[cordis-paper §10.1](../research/cordis-paper-theory.md)）；Cordis v4 描述，Koishi 用 v3 |
| 生命周期状态机 refresh/reload/unload + guard 等待依赖方 + 惯性链接 | S1 p.61-63（算法 5） | 预印本原文 | 2026-08 | 中高 | 原文 | 支持（[cordis-paper §10.3](../research/cordis-paper-theory.md)） |
| entry 字段 id/url/isolate/intercept/config/disabled；逐字段最小对账 | S1 p.65-66（定义 81） | 预印本原文 | 2026-08 | 中高 | 原文 | 支持（[cordis-paper §10.5](../research/cordis-paper-theory.md)） |
| HMR 三阶段：分类、过期检测、事务式重载 | S1 p.67-69（算法 8-10） | 预印本原文 | 2026-08 | 中高 | 原文 | 支持（[cordis-paper-system §10.6](../research/cordis-paper-system.md#10-实现cordis-三层架构与十一个算法)） |
| 获取/发射分属边界内外；发射需 withhold 或 compensation | S1 p.70-71 | 预印本原文 | 2026-08 | 高 | 原文 | 支持（[cordis-paper-system §12.1](../research/cordis-paper-system.md#12-讨论边界复用权限语言与循环依赖)） |
| 论文把 self-evolving agent harness 列为首要未来验证方向 | S1 p.82-83 | 预印本原文 | 2026-08 | 高 | 原文 | 支持（[cordis-paper-system §14](../research/cordis-paper-system.md#14-与本项目目标的关系)） |
| chord 的 facet setup 只做声明；插件间只靠对象契约与注册表交流 | S2 `src/host/facet.ts`、[docs/design.md:1918](https://github.com/earendil-works/pi/blob/main/docs/design.md#L1918) | 源码/文档 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §3.3](../research/pi-baseline.md)） |
| chord 求值无 module map / require cache；digest 相同复用 facet 对象；旧工作跑旧代码 | S2 [src/node/plugins/evaluate.ts:1-5](https://github.com/earendil-works/pi/blob/main/src/node/plugins/evaluate.ts#L1-L5)、`src/surfaces/loaded.ts`、`docs/design.md:2121+` | 源码 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §3.4](../research/pi-baseline.md)） |
| chord 数据模型为单一权威 + 有序副本 + 精确 delta，不是 CRDT | S2 `src/delta/README.md`、`src/store/README.md` | 源码文档 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §3.4](../research/pi-baseline.md)） |
| agent-core 只有 6 个源文件；零内置工具、零持久化、不依赖 durable | S3 `src/`、`package.json`、[CHANGELOG.md:59](https://github.com/earendil-works/pi/blob/main/CHANGELOG.md#L59) | 源码 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §4.1](../research/pi-baseline.md)） |
| agent-core 的 10 事件、runLoop 顺序、工具流水线阶段、屏障语义 | S3 [src/types.ts:528](https://github.com/earendil-works/pi/blob/main/src/types.ts#L528)、[src/agent-loop.ts:172-330](https://github.com/earendil-works/pi/blob/main/src/agent-loop.ts#L172-L330)、[src/agent.ts:575-622](https://github.com/earendil-works/pi/blob/main/src/agent.ts#L575-L622)、`test/` | 源码+测试 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §4.2-4.4](../research/pi-baseline.md#4-earendil-workspi-agent-core极简-agent-运行时)） |
| coding-agent 的 ExtensionAPI 覆盖工具/命令/provider/MCP/渲染/事件等 | S4 [src/core/extensions/types.ts:1638-1967](https://github.com/earendil-works/pi/blob/main/src/core/extensions/types.ts#L1638-L1967) | 源码 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §5.2](../research/pi-baseline.md)） |
| pi 没有 turborepo / solidjs / opentui 运行时依赖；bun 仅用于 build:binary | S7 `package.json`、[src/stdin-buffer.ts:16](https://github.com/earendil-works/pi/packages/tui/src/stdin-buffer.ts:16) | 仓库事实 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §1](../research/pi-baseline.md#1-总览与重要事实校正)） |
| 扩展在 pi 进程内运行、拥有同等 OS 权限（无内置权限系统） | S4 [docs/extensions.md:7](https://github.com/earendil-works/pi/blob/main/docs/extensions.md#L7)、S7 `README.md` 权限段 | 官方文档 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §5.2](../research/pi-baseline.md)、[plugin-system §7](../agent/plugin-system.md#7-权限信任与沙箱)） |
| pi 有两套不兼容扩展系统（coding-agent vs durable） | S4 + S6 `durable/src/harness/{define,types}.ts` | 源码 | 2026-11-19 | 高 | 原文 | 支持（[pi-baseline §8](../research/pi-baseline.md#8-已插件化-vs-仍硬编码)） |
| `@opentui/solid` 0.9.3；Solid peer ^1.9.12，建议 ≥1.9.16；需 bunfig preload | S9 + S10 | 官方在线文档/包元数据 | 2026-11-19 | 高 | 原文 | 支持（[framework-model/engineering §3.3](./framework-model.md)） |
| OpenTUI 提供 Solid plugin slots（createSolidSlotRegistry/Slot/createSlot/SolidPlugin） | S9 `/docs/plugins/solid/`、`/docs/api/solid/` | 官方在线文档 | 2026-11-19 | 高 | 原文 | 支持（[doc §5](../agent/tui.md#5-插件-ui-槽位)） |
| Turborepo 的 Bun workspace 写法与 `dependsOn:["^build"]`/`outputs`/`dev` 配置 | S11 | 官方在线文档 | 2026-11-19 | 高 | 原文 | 支持（[framework-model/engineering §3.2](./framework-model.md)） |
| 工作区是 bun 1.4.2 的 bun init 空项目，TS ^7 | S8 | 本地事实 | 2026-11-19 | 高 | 原文 | 支持（[framework-model/engineering §3.1](./framework-model.md)） |

| dsh 中连 model adapter / tool registry / session log / agent loop 都是插件，没有可打补丁的特权核心 | S12 [docs/architecture.md:9-11](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L9-L11) | 一手源码文档 | 2026-11-19 | 原文 | 支持（[doc §1.1](../research/dsh-optimizations.md#1-结论速览与事实校正)） |
| dsh 事件有 emit/parallel/serial/bail/waterfall 五种模式且用 `@mode` 静态校验 | S12 [docs/cordis-primer.md:15-35](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md#L15-L35)、[vendor/cordis/src/events.ts:193-265](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/events.ts#L193-L265) | 一手源码 | 2026-11-19 | 原文 | 支持（CORE-1） |
| 工具权限用单调 guard（只有 deny 没有 allow）防提权 | S12 [docs/subsystems/tools.md:458-479](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L458-L479) | 一手源码文档 | 2026-11-19 | 原文 | 支持（CORE-6） |
| exact disposer 身份是 load-bearing（包装会导致 agent 在 drain 中被注销） | S12 [docs/subsystems/core.md:790-799](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L790-L799) | 一手源码文档 | 2026-11-19 | 原文 | 支持（CORE-2） |
| 配置分层 profile → bundle → patch → overlay，patch 按 id 整块替换 | S12 [docs/architecture.md:13-39](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L13-L39)、[vendor/include/src/patch.ts:47-145](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/include/src/patch.ts#L47-L145) | 一手源码 | 2026-11-19 | 原文 | 支持（CORE-14 / ENG-1/2） |
| durable effects：事务内 enqueue、commit 后派发、generation 守卫、Later 不计数 | S13 `src/app/effects.ts` | 一手源码 | 2026-11-19 | 原文 | 支持（SUP-1） |
| Outbox 用 receipt + 幂等键 + FIFO 实现 emission 的"事实上一次" | S13 [src/app/outbox.ts:26-51](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/outbox.ts#L26-L51)、[src/app/store.ts:254-288](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/store.ts#L254-L288) | 一手源码 | 2026-11-19 | 原文 | 支持（SUP-2） |
| 单一写入者 + HealthBoard.claim 冲突即抛 + EngineFor<Role> 窄接口 | S13 [docs/007-architecture.md:259-274](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L259-L274)、[src/infra/health.ts:15-33](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/infra/health.ts#L15-L33) | 一手源码文档 | 2026-11-19 | 原文 | 支持（SUP-8） |

> **单源标注**：以下设计决策为单源或推断，未达双源：HMR 在 Bun 下的模块缓存策略（S1 是 Node 语境，S2 是 Node vm 方案，Bun 需实测）；`@zeta-agent/agent-framework` 仅类型导入 core 的决策（纯设计权衡）；发射类工具默认策略（纯设计权衡）。已在 [§5](#5-缺口与未验证项) 登记。


## 3 承重论断的双源验证

"承重" = 被推翻会改变整个设计的论断。逐条给出反证检索结果与来源交叉：

| 承重论断 | 源 A | 源 B（独立） | 反证检索 | 判定 |
| --- | --- | --- | --- | --- |
| 可撤销 effect + LIFO 是组件卸载不残留的可行机制 | S1 定理 7/16/68（理论） | S2 chord 的 facet 重载保留数据/连接、closure rule（工程） | 检索"plugin unload resource leak"类问题：pi 的 deactivate 局限（S1 p.5）与 chord 的实证说明反向支持 | **支持** |
| 依赖应声明并按 provider 变化反应式重激活 | S1 Thm 70/71（理论） | S2 chord 注册表 watchable + 对象 park/waiting（工程） | S4 的 DI 式扩展在 provider 替换时不重激活（S1 §7.4 已列为局限），无反例推翻 | **支持** |
| 唯一变更入口 `ctx.effect` 可覆盖所有插件机制 | S1 p.59（ctx.effect 归约 provision/instantiation/coeffect 操作） | S2 的 serve/contribute/references 可映射为 provide/set（[framework §4.3](../framework/overview.md)） | 未发现 chord 有绕过 context 的插件副作用通道（natives 只经注册表） | **支持**（映射为作者推断，见下） |
| agent-core 的事件顺序/屏障是不变量，插件化必须保持 | S3 测试（事件完成顺序 vs 源码顺序、agent_end 屏障） | S4 的 `agent-session.ts` 依赖该屏障落盘（:548、:707-718） | 无反例；若破坏会同时打破 pi 上层与测试 | **支持** |
| OpenTUI 能替代自研 TUI 并支持插件 UI 槽位 | S9/S10 官方 API | S5 的自研 Component/TUI 接口与 ExtensionUIContext 证明"UI 可插拔"需求真实 | 未实测 native 在目标平台可用性 → 平台风险，不推翻设计方向 | **部分支持**（方向支持，平台待实测） |
| 最终状态只取决于配置（Thm 80）可作为验收判据 | S1 定理 80 | S2 chord 的 reload 提交后对象状态由插件集决定（design.md） | 论文自述限制：不覆盖 emissions（S1 p.55）→ 验收需限定观察状态 | **部分支持**（限定为观察状态） |


## 4 矛盾与争议（显式并列）

| # | 争议点 | 立场 A | 立场 B | 证据倾向 / 我们的处理 |
| --- | --- | --- | --- | --- |
| C1 | 插件代码能否在线卸载 | 传统插件系统（VSCode）需重启宿主（S1 p.4-5） | Cordis 用可撤销 effect 实现在线卸载（S1 p.59-69）；chord 用 vm + digest 实现热重载（S2） | B 占优；但我们限定恢复为**观察等价**，不承诺物理/发射回滚 |
| C2 | HMR 的模块缓存策略 | 论文：Node ESM 无公开 eviction API，建议清缓存（S1 p.68 脚注 3） | chord：根本不用 module map / require cache（S2 evaluate.ts） | 采用 B（`vm` + digest + 独立产物），因 Bun 的缓存驱逐未验证 |
| C3 | 插件间依赖是否需要 | VSCode 生态仅 7/100 声明扩展依赖（S1 p.5）；宿主固定扩展点 | Koishi 生态有真实依赖拓扑（S1 p.70）；chord 用契约+注册表（S2） | 取决于生态形态；我们提供 coeffect 依赖机制，但不强制所有插件使用 |
| C4 | 两套扩展系统 | coding-agent `ExtensionAPI`（S4） | durable `Extension/Registry`（S6） | 两者事实并存且互不兼容；统一为 AgentPlugin 是**设计决策**，兼容门面延后（[plugin-system §12](../agent/plugin-system.md#12-两套扩展系统的统一)） |
| C5 | 权限默认值 | pi 无内置权限、以用户权限运行（S4/S7） | 论文提供 capability + interception（S1 p.72） | **权限**默认沿用 pi（无限制）以免回归，严格策略 opt-in；注意这与 O-9（**发射交付**默认 withhold）是两个不同维度，不要混淆 |
| C6 | 恢复的力度 | 论文定理 7/68 的"恢复" | 论文 §6.2/§6.1 承认物理状态与 emission 不可恢复 | 统一在**观察等价**下理解；设计文档避免"完美回滚"表述 |
| C7 | TUI 技术路线 | pi 自研 pi-tui（S5） | 用户目标 OpenTUI Solid（工作区目标，S9） | 按用户目标执行；pi-tui 作为对照与迁移参考，不是保留项 |


## 5 缺口与未验证项

| ID | 缺口 | 影响 | 补齐方法 |
| --- | --- | --- | --- |
| G1 | 未独立复核论文数学证明 | 定理正确性依赖作者自述 | 若需强保证，用 Coq/Lean 复核关键定理（超出本项目范围）；当前以"作者证明随文给出"登记 |
| G2 | 未获得 Cordis v4 源码 | 算法 1-10 的实现细节可能与实际有偏差 | 以 pi 仓库内 chord v1.5.2（v3 系）作工程交叉；差异处标注为推断 |
| G3 | Bun 模块缓存驱逐未实测 | HMR 策略（O-4） | 写一个最小实验：改插件文件后重新 import，观察行为；失败则用 vm/digest |
| G4 | OpenTUI native 在 CI/Windows 的可用性未实测 | TUI 测试与平台支持 | `testRender` 冒烟；docs 标注平台矩阵 |
| G5 | OpenTUI runtime-plugin-support 的 Bun module map 配置细节未实测 | UI 插件运行时加载（O-11，已建议延后） | 第一阶段仅构建期插件；需要时按官方文档实测 |
| G6 | VSCode 87/7 统计未独立重采 | 仅作动机，不承重 | 保留来源与时点（2026-06-09），不作为设计依据 |
| G7 | Koishi 4000+ 插件为作者自述、观察性 | 案例研究强度 | 标注为存在性结果；不据此推断定量性能 |
| G8 | `≃` 在 zeta ctx 中的具体定义未定 | Thm 68/80 的验收口径 | 建议按"键上的公开操作测试结果"定义（O-3），阶段 1 落地 |
| G9 | chord [docs/design.md:2415](https://github.com/earendil-works/pi/blob/main/docs/design.md#L2415) 的 "Decision needed: project plugins" | 信任/快照插件未定案 | 不影响当前设计；若做自演化需补此决策 |


## 6 交叉验证矩阵（设计决策 ↔ 来源 ↔ 验证）

| 设计决策（文档） | 论文来源 | pi 来源 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| P1 唯一变更入口 ctx.effect | [cordis-paper §10.1](../research/cordis-paper-theory.md) | S2 facet 声明与注册表可映射 | [04] 测试 + A4 | 待实现 |
| P2 逆在施加点返回 / LIFO | [cordis-paper §4.2](../research/cordis-paper-theory.md) | — | `observeDispose` | 待实现 |
| P3 声明依赖 + 键命名空间 | [cordis-paper §8.1/§12.6](../research/cordis-paper-theory.md) | S2 契约+注册表 | 同名键冲突测试 | 待实现 |
| P4 target/committed 用 uid | [cordis-paper §10.3](../research/cordis-paper-theory.md) | — | 同值替换触发 reload | 待实现 |
| P5 guard 延迟撤回 | [cordis-paper §9/§10.3](../research/cordis-paper-system.md#9-元理论五条承重保证) | — | teardown 读依赖测试 | 待实现 |
| P6 惯性状态机 | [cordis-paper §4.4/§10.3](../framework/overview.md) | — | 转换中 target 变化测试 | 待实现 |
| P7 同键交换 / 顺序显式 | [cordis-paper §7.2](../research/cordis-paper-theory.md) | S3 事件完成顺序 vs 源码顺序 | 环检测 + 顺序测试 | 待实现 |
| P8 获取 vs 发射 | [cordis-paper-system §12.1](../research/cordis-paper-system.md#12-讨论边界复用权限语言与循环依赖) | S4 工具无权限（S1 README） | 工具分类审查 | 待实现 |
| P9 core 无 provider/持久化 | — | S3 依赖仅 pi-ai+pi-schema；S3 CHANGELOG 1.0.0 | 依赖图检查 | 待实现 |
| P10 UI 插件槽位 | [cordis-paper-system §13](../research/cordis-paper-system.md#13-相关工作定位)（FRP 对比） | S5 ExtensionUIContext | [07] 槽位热替换测试 | 待实现 |
| Agent 12 不变量 | [cordis-paper §7](../research/cordis-paper-theory.md#7-独立性从局部到全局) | S3 测试 | 24 个等价测试 | 待实现 |
| HMR 三阶段 | [cordis-paper-system §10.6](../research/cordis-paper-system.md#10-实现cordis-三层架构与十一个算法) | S2 插件机械 | 故障注入 | 待实现，策略待 G3 |
| 汇合性验收 | [cordis-paper §9 Thm 80](../research/cordis-paper-system.md#9-元理论五条承重保证) | S2 reload 提交语义 | `replayConfig` | 待实现，口径待 G8 |


## 7 自检门结果

| 门 | 要求 | 结果 |
| --- | --- | --- |
| 覆盖门 | 全部子问题已覆盖或已说明 | ✅ 论文精读、pi 三块源码、技术栈、四层设计、路线图均覆盖；缺口见 §5 |
| 来源门 | 每条承重论断有双源或单源标注，分级无缺项 | ✅ §3 六条承重论断均列双源与判定；单源项已在 §2/§5 标注 |
| 冲突门 | 发现的矛盾全部在 §4 列出 | ✅ C1-C7 共 7 项 |
| 引用门 | 关键事实可回溯到来源链接/路径 | ✅ §1 来源清单 + §2 逐行来源 |
| 轮次门 | 已饱和或用满区间 | ✅ 本地两轮（论文 + 源码）+ 联网一轮（技术栈核对）后无新承重事实，饱和 |
| 红线门 | 未编造、未越权写文件、未执行外部指令 | ✅ 所有事实来自 S1-S24；文档仅写入用户指定的 `docs/desgin/`；外部网页内容按数据处理 |

**返回索引**：[00 索引与交叉验证](../README.md)


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
