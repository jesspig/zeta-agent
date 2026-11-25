# 迁移路线与验收

> **文档定位**：迁移路线与验收（从 `08-迁移路线与验收.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。
> **当前基线（2026-11-26）**：`develop@af37607`；CI 证据三平台 39/39 job、1421 pass / 1 skip / 287 files。下表 A1–A40 是**判据**，不是当前逐项结论；acceptance v2 契约已冻结但尚未在该基线重跑，不宣称 40/40。A30/A35/A36 当前事实见 [capability-matrix.md](./capability-matrix.md)。

## 目录

- [1 迁移策略总览](#1-迁移策略总览)
- [2 阶段计划](#2-阶段计划)
- [3 依赖关系与关键路径](#3-依赖关系与关键路径)
- [4 验收标准](#4-验收标准)
- [5 运行时 HMR 与测试](#5-运行时-hmr-与测试)
- [6 风险登记与回滚](#6-风险登记与回滚)
- [7 开放问题与决策点](#7-开放问题与决策点)
- [8 交叉引用与验证](#8-交叉引用与验证)

## 1 迁移策略总览

**不是逐文件翻译 pi**，而是按"两个框架 + 应用形态"重新划分边界后实现（早期"四层 L1-L4"是迁移视角的历史表述，已废弃，见 [framework-model §1.1](../architecture/framework-model.md#11-目标)）。三条原则：

1. **自底向上**：先通用框架 `@zeta-agent/framework`（内部组件），再 Agent 框架 `@zeta-agent/agent-framework`（内部组件），最后应用形态（agent 插件 / TUI / CLI 装配）；应用层只调 facade。
2. **测试先行**：L2 的 12 条不变量等价测试（[agent-framework §13](../agent-framework/state-and-events.md#13-测试策略与不变量等价清单)）先于插件管线实现；L1 的汇合性/可逆性测试先于 loader/HMR。
3. **双轨兼容**：保留 pi 的字段赋值与两套 Extension 门面作为兼容层（[agent-framework §4.2 插件管线](../agent-framework/runtime.md#42-方案)、[plugin-system §12](../agent/plugin-system.md#12-两套扩展系统的统一)），老扩展可继续用。

**范围边界**：pi 仓库只读作为事实来源，不在其上修改；新代码写在 `zeta-agent` 工作区（当前为 `bun init` 空项目）。


## 2 阶段计划

### 阶段 0：工程骨架（0.5 天）

**目标**：把当前 `bun init` 空项目变成可运行的 monorepo 骨架。

- 根 `package.json`：`workspaces: ["apps/*","packages/*","packages/components/*","packages/agent-components/*"]`（**C 方案**，见 [engineering §5.1/§8](../architecture/engineering.md#8-构建任务图turbojson-草案)；`components/`、`agent-components/` 既是分组目录也是聚合包，各自有 `package.json`）、`devEngines` 锁 bun 1.4.2、`turbo` 脚本。
- `turbo.json`、`tsconfig.base.json`、`bunfig.toml`（OpenTUI preload）。
- 建两个 facade 包（`packages/framework`、`packages/agent-framework`）、组件子包（`packages/components/*` 下 cordis/events/capabilities/loader/observability/security 六个）与两个聚合包（`packages/components`、`packages/agent-components`）、`apps/zeta-cli` 的最小 `package.json` / `tsconfig`。
- 安装锁定：`solid-js@^1.9.16`、`@opentui/core@0.9.3`、`@opentui/solid@0.9.3`、`turbo@<pinned>`、`esbuild`（可选 peer）。

**退出条件**：`bun install` 成功；`turbo run build/typecheck/test` 空任务全绿；依赖图无环。

### 阶段 1：`@zeta-agent/framework` 内部组件（2-3 天）

**目标**：ctx.effect / fiber 状态机 / coeffect / registry 可运行并通过论文判据测试。组件以 C 方案的独立 workspace 包落地（`packages/components/cordis`、`events`、`capabilities`、`loader`、`observability`、`security`；原 scope/seam/registry/health 并入 capabilities、hmr 并入 loader），facade 包只做装配。

> **开工前必读校正（[cordis-source-verification.md](../research/cordis-source-verification.md)）**：阶段 1 实现须以官方源码验证后的设计为准，而非早期草案——① FiberState 是 **6 态**（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING），不是 5 态；② Effect 接受 **4 种形态**（Disposer / 同步 iterable / Promise&lt;Disposer&gt; / 异步 iterable）；③ committed view 存 **Impl**（含 `check()` 动态能力判定与 `dependents`），不是纯 uid；④ 撤销是**两层语义**——单 effect 内严格 LIFO，fiber 卸载多 effect 时逆序启动、并发执行；⑤ 事件静态约束靠 `interface Events` 声明合并（非 @mode），`parallel` 用 `Promise.allSettled` + `AggregateError`。

- 实现 [framework §3-7](../framework/core-semantics.md#3-核心数据模型)：`defineKey`、`createContext`、`ctx.effect`、`get/set/isolate/intercept`、`use`、`refresh/reload/unload/notify`、LIFO 逆、FAILED。
- 实现 [framework §10](../framework/components.md#10-注册表与-contribution)：`defineRegistry` / `compose` / `accepts`。
- 实现 [framework §11](../framework/api-and-testing.md#11-测试与调试-api) 测试工具：`assertQuiescent`、`assertNoResidue`、`replayConfig`、`observeDispose`、`faultInject`。
- **不实现**对象运行时与 HMR（留到阶段 3/5）。

**退出条件**：
- LIFO 逆序断言通过；
- 随机加载/卸载后无残留绑定（Cor 69）；
- 多种加载顺序最终观察状态一致（Thm 80）；
- guard 场景：消费者 teardown 能读正在撤回的依赖（Thm 70）；
- 依赖环静态检测报错。

**回滚**：此阶段无外部依赖，失败即重写内核；不污染上层。

### 阶段 2：`@zeta-agent/agent-framework`（2-3 天）

**目标**：在不变量等价测试保护下，把 agent loop 落地为插件管线。

- **先写** [agent-framework §13](../agent-framework/state-and-events.md#13-测试策略与不变量等价清单) 的 24 个测试（12 条 × legacy/plugin）。
- 实现 [agent-framework §3](../agent-framework/runtime.md#3-公开-api-草案) 类型与 `runLoop`（逐字对应 [pi-baseline §4.3](../research/pi-baseline.md#4-earendil-workspi-agent-core极简-agent-运行时) 的 11 步）。
- 实现 [agent-framework §4](../agent-framework/runtime.md#4-agentplugin-管线替代-monkey-patch) 插件管线 + legacy 兼容层。
- 实现 [agent-framework §8](../agent-framework/tools-and-policies.md#8-工具流水线)：工具流水线、terminate 全批次、runToolCall。
- 实现 [agent-framework §10](../agent-framework/state-and-events.md#10-事件协议与屏障语义)：事件屏障、`agent_end` ≠ idle。

**退出条件**：24 个等价测试全绿；`turbo run test` 通过；core 无 provider/持久化依赖（依赖图检查）。

**回滚**：保留 legacy 路径；插件管线失败可临时禁用（配置开关），回退到字段赋值。

### 阶段 3：`@zeta-agent/agent` 插件集（3-4 天）

**目标**：用插件装配出一个可用 agent（工具、技能、提示词、会话、权限、MCP、模式）。

- 实现 [plugin-system §3](../agent/plugin-system.md#3-工具插件内置工具也走插件)：内置工具插件化 + replaceable。
- 实现 [plugin-system §4](../agent/plugin-system.md#4-技能提示词主题插件)：资源注册表 + 解析器插件。
- 实现 [plugin-system §5](../agent/plugin-system.md#5-会话与持久化插件)：会话插件 + 内存/JSONL 后端（SQLite 后置）。
- 实现 [plugin-system §6-7](../agent/plugin-system.md#6-工具副作用的边界分类)：获取/发射分类 + 权限/intercept + 沙箱基础。
- 实现 [plugin-system §9-10](../agent/plugin-system.md#9-mcp-与-provider-插件)：MCP 插件、provider broker、模式插件。

**退出条件**：`createAgent()` 可跑通一个完整 turn（含工具调用）；工具热插拔后 transcript 声明同步；权限策略热更新不触发 reload；print/json 模式可用。

**回滚**：每类插件可单独禁用；保留 pi 兼容门面（若时间允许提前做）。

### 阶段 4：`@zeta-agent/tui` + CLI 装配（2-3 天）

**目标**：OpenTUI Solid 界面 + CLI 入口，替换 pi 的交互式体验。

- 实现 [doc §3-5](../agent/tui.md#3-架构renderer-signal-桥-插件槽位)：renderer、signal 桥、Solid slots。
- 实现 [doc §6-8](../agent/tui.md#6-与-pi-tui-的对应关系)：主题、快捷键、生命周期。
- 实现 `apps/zeta-cli`：参数、登录（最小）、loader 启动、模式选择（[plugin-system §11](../agent/plugin-system.md#11-装配流程)）。
- 实现 [doc §9](../agent/tui.md#9-测试策略)：`testRender` 帧快照。

**退出条件**：`bun apps/zeta-cli/src/index.ts` 可交互对话；工具调用渲染正确；插件槽位可热替换；`--print/--json/--rpc` 可用；帧快照测试通过。

**回滚**：interactive 模式失败时，CLI 默认走 print 模式；TUI 包可独立回退。

### 阶段 5：HMR、对象运行时与自演化护栏（可选/后续，3-5 天）

**目标**：运行时热重载、跨进程对象、受控自演化。

- [framework §8](../framework/components.md#8-组件加载器与-hmr)：三阶段 HMR（先做构建+digest+事务重载，跨 host rollout 后置）。
- [framework §9](../framework/components.md#9-对象运行时与跨进程边界可选子路径)：contract/document/store/link 最小实现（可选子路径）。
- [plugin-system §8](../agent/plugin-system.md#8-自演化与安全管理)：自演化护栏（required root、环检测、沙箱、试加载回滚）。
- [plugin-system §12](../agent/plugin-system.md#12-两套扩展系统的统一)：pi 两套 Extension 兼容门面。
- **护栏强化**（来自 [recursive-self-evolution.md §6](../research/recursive-self-evolution.md#6-落地批次)）：晋升 digest 校验、workspace 不覆盖 + RESUME、stage-scoped 权限、grader tripwire、预算恒等式——即便不做完整递归自演化，这些也强化受控热替换。

**退出条件**：改一个插件文件 → 不重启进程即生效，且其他插件的会话/连接保留；build/evaluate/exports 校验失败保留旧 committed artifact；apply 失败仅目标 fiber 进入 FAILED，并在下次文件变更时重试；自修改候选在提交宿主前完成隔离构建、求值、exports、依赖环与 capability 审查。

### 阶段 6：递归自演化研究轨（可选/后续）

**定位**：默认产品 profile 不启用自动代码生成与部署；完整建设路线包含研究轨实现，但研究轨保持默认禁用，仅在具备可重放任务与独立评估器时启用。

- 实现 [recursive-self-evolution.md §6](../research/recursive-self-evolution.md#6-落地批次) 的研究轨项：策略白名单沙箱、DecisionSurface 对偶、冻结 trace、fitness seam、资格门禁 + incumbent 单调晋升、ExperienceLibrary。
- 验证来自 DREAM-RSI 的 A16-A20（见 §4 验收标准）。

**退出条件**：同一任务上新旧策略可在冻结 trace 上重放比较；新策略只有严格更优（且资格合格）才晋升；递归过程不破坏 24 条不变量。


## 3 依赖关系与关键路径

```mermaid
flowchart LR
    S0[阶段0 工程骨架] --> S1[阶段1 framework 内核]
    S1 --> S2[阶段2 agent-framework]
    S2 --> S3[阶段3 agent 插件集]
    S3 --> S4[阶段4 TUI+CLI]
    S4 --> S5[阶段5 HMR/自演化]
    S1 -.测试工具.> V[验证]
    S2 -.等价测试.> V
    S3 -.插件化验收.> V
```

**关键路径**：阶段 1 的 fiber 语义 → 阶段 2 的不变量等价测试 → 阶段 3 的插件可逆性。这三步决定整个架构是否成立；阶段 4/5 是表现层与增强。

**并行机会**（不同文件、无冲突）：

- 阶段 1 后期：对象运行时的子路径（§9）可与阶段 2 并行（独立目录）；
- 阶段 3 内：工具插件、资源插件、会话插件可由子代理并行实现（各自独立文件）；
- 阶段 4 内：TUI 组件与 CLI 装配可并行（接口先定）。


## 4 验收标准

从 [framework-model/engineering §12](../architecture/engineering.md#12-验收标准) 展开为可检查清单：

| # | 标准 | 证据形式 | 对应阶段 |
| --- | --- | --- | --- |
| A1 | `turbo run build/typecheck/test` 全绿；lockfile 提交；依赖图无环 | CI 日志 / `turbo run graph` | 0-4 |
| A2 | [09](../architecture/fact-registry.md) 每条 P1-P10 指向实现文件与测试 | 交叉验证矩阵 | 1-4 |
| A3 | 同配置不同加载顺序 → 相同观察状态（Thm 80） | `replayConfig` 测试 | 1 |
| A4 | 随机加载/卸载后所有逆调用一次且仅一次，无残留（Cor 69） | `assertNoResidue` / `observeDispose` | 1 |
| A5 | guard：消费者 teardown 能读依赖；撤回延迟（Thm 70） | 场景测试 | 1 |
| A6 | 12 条 agent-core 不变量（pi-baseline §9）的 legacy/plugin 双版测试全绿（`inv-core-` 前缀，24 个；区别于工具流水线 12 条 `inv-tool-`），并通过双门：门 1 每条加固断言有真实触发条件哨兵（`xxxObserved/Invoked/Verified`），门 2 `INVARIANT_TEST_POINTS` 12 条要点映射齐全且关键词/哨兵命中对应断言块（`bun scripts/check-invariant-points.mjs`） | 24 个测试报告 + 双门门 1 哨兵检查 + 门 2 要点门脚本输出 | 2 |
| A7 | 工具热插拔后 transcript 声明同步；权限策略热更新不 reload | 集成测试 | 3 |
| A8 | 工具副作用分类审查通过；发射类默认策略符合配置 | 工具清单审查 | 3 |
| A9 | `testRender` 帧快照覆盖消息/工具/状态/overlay/槽位热替换 | 帧快照测试 | 4 |
| A10 | `--print/--json/--rpc` 在无 TTY 下完整可用 | CI 冒烟 | 4 |
| A11 | 插件文件变更不重启生效；build/evaluate 失败保留旧 artifact；apply 失败目标 fiber 留 FAILED 并于下次变更重试；critical root 另验补偿事务 | HMR 单元/E2E/故障注入 | 5 |
| A12 | 自修改候选在提交宿主前完成隔离构建/求值、exports 校验、静态依赖环与 inject capability 审查；失败或越权不修改宿主 | 试加载隔离/越权拒绝测试 | 5 |
| A13 | 五模式派发与 `interface Events` 声明一致；单调 guard 任意顺序下 deny 不翻回 allow | 声明合并类型测试（`@ts-expect-error`）+ 排列测试（[10 CORE-1/6](../research/dsh-optimizations.md#3-核心运行时优化core)） | 0-2 |
| A14 | same config 不同顺序 → `--dump-config` 输出观察等价；patch 按 id 整块替换可复现 | 汇合测试 + patch 测试（[10 CORE-14/ENG-2](../research/dsh-optimizations.md#4-工程配置与-ui-优化eng)） | 0-1 |
| A15 | 显式 durable 模式使用持久 journal，提供 at-least-once 投递；commit 前崩溃与 dispatch 成功后 receipt 持久化前崩溃均可恢复；可观察副作用不重复依赖 adapter 的 `(kind,key)` 幂等协议；默认内存 journal 不得称为 crash-durable | 双崩溃窗口 + 并发 commit + 幂等 adapter 测试（[10 SUP-1/2](../research/dsh-optimizations.md#5-域层与治理优化sup)） | 3 |
| A16 | 晋升单调性：incumbent 参赛，新策略仅严格更优且资格合格才替换 | 候选竞争测试（[SE-D6](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A17 | 重放不变量：budget===order.length、无重复、每步 isLegal、best≤runBest | 框架级断言（[SE-D10](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A18 | 观察等价晋升：晋升前后 ctx 在键上的公开操作测试一致 | 汇合性扩展测试（[SE-H3](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 5-6 |
| A19 | 无 ground truth：grader verdict / rubric / score 不进改进上下文，tripwire 命中即抛错 | 泄漏注入测试（[SE-H8](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 5-6 |
| A20 | 递归不破坏不变量：自演化前后 24 条不变量等价测试全绿 | 不变量回归（[SE-H11](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A21 | 可观测性：日志含 runId/fiber 归因；OTLP 故障降级本地；敏感字段脱敏；观测不破坏 Thm 80 | [observability.md](../framework/observability.md) 契约测试 | 2-3 |
| A22 | 执行隔离：工具调用走 ExecutionBackend；capabilities() 关键层降级即 FAILED；凭证不进日志/snapshot | [security.md](../agent/security.md) 能力探测 + 凭证测试 | 3-5 |
| A23 | egress 与审计：发射目标白名单默认拒绝；进程外 AuditSink 带 finalized 完整性标记 | [security.md §4/§6](../agent/security.md) 门禁 + 审计测试 | 3-5 |
| A24 | 官方源码对照：@mode 措辞、HMR 按 unit 部分提交、撤销两层语义与 cordis 官方一致 | [cordis-source-verification.md](../research/cordis-source-verification.md) 对照检查 | 0-2 |
| A25 | 类型骨架可编译：Effect 4 形态 / Impl 视图 / 6 态状态机 / AgentPluginApi（含 capabilities/onEffect/addRedactor）通过 `tsc` | [core-semantics.md](../framework/core-semantics.md)、[runtime.md](../agent-framework/runtime.md) 类型测试 | 0-1 |
| A26 | 压缩正确性：typed recap 六段齐全；Offloader 外置块可由 `workspace:///` 取回；压缩纳入 agent_end 屏障；双阈值 + peak 指标生效 | [plugin-system.md §5.1](../agent/plugin-system.md)、[harness-optimization-papers.md](../research/harness-optimization-papers.md) CT-1/2/3 | 3-4 |
| A27 | 经验检索：evidence 完整落盘（code/scores/traces）；`experience.query` 支持任意历史候选的非马尔可夫检索；evidence store 无有损摘要 | [observability.md §3.1](../framework/observability.md)、SE-M3 | 5-6 |
| A28 | 多租户 realm 隔离：per-tenant 资源经 realm 解析；跨租户事件不串；配额作为 coeffect 可 reserve | [security.md §7](../agent/security.md#7-多租户identity-与-realm) | 3-5 |
| A29 | 评测体系：fitness seam 可插拔；A/B 与回归门禁可运行；实验隔离与 search/test 分离 | [engineering.md §9.3](../architecture/engineering.md#93-评测与基准体系缺口-5-补全)、SE-M11 | 5-6 |
| A30 | 部署三态均为真实拓扑：local 单文件、daemon HTTP/token/heartbeat、remote SDK/gRPC + 远程 backend；readiness/liveness/configDigest 接入真实 runtime/RPC；configDigest 使用 canonical encoding + SHA-256；启动/发布校验主二进制与嵌入资源架构 | [engineering.md §9.1](../architecture/engineering.md#91-部署拓扑与三态运行缺口-7-补全) | 5 |
| A31 | package graph 无环、跨包相对 import 被拒 | `scripts/check-core-dependencies.mjs`、`scripts/guard-architecture.mjs`、`scripts/guard-architecture.spec.mjs` | 0-5 |
| A32 | 公开 API 无未实现 stub / 静默 no-op | `scripts/check-api-stubs.mjs`、`scripts/check-facade-exports.mjs`、backend 契约测试 | 0-5 |
| A33 | 持久化三类崩溃与未知结果可恢复 | `packages/agent/src/session/`、`packages/components/security/src/outbox.spec.ts` | 3-5 |
| A34 | run/tool/session 并发生命周期完备 | `packages/agent-framework/src/runtime/`、`packages/agent/src/session/tree.atomic.spec.ts` | 2-5 |
| A35 | 文件/进程/网络/凭证/审计由真实边界强制 | `packages/components/security/`、`packages/agent/src/tools/backend.contract.spec.ts` | 3-5 |
| A36 | local/daemon/remote 与三平台 12 target 矩阵通过 | `scripts/gate-platform.mjs`、`scripts/smoke-local.ts`、`scripts/release-check.mjs` | 5 |
| A37 | Provider/MCP/RPC/CLI conformance 全绿 | `packages/agent/src/providers/conformance.spec.ts`、`packages/agent/src/plugins/mcp/conformance.spec.ts`、`packages/deploy/src/rpc.spec.ts` | 3-5 |
| A38 | 性能预算与资源增长有回归门 | `scripts/gate-performance.mjs`、`packages/deploy/src/budget.spec.ts` | 5 |
| A39 | 文档能力矩阵与代码装配自动一致 | `scripts/check-capability-matrix.mjs`、`capability-matrix.md` 机器可读块 | 5 |
| A40 | 研究轨所有晋升路径强制经过四道护栏 | `packages/agent/src/research/guardrails.spec.ts`、`promotion.spec.ts`、`fitness.budget-identity.spec.ts` | 6 |


## 5 运行时 HMR 与测试

> **定位**：我们复刻 Cordis 论文，HMR 属于 component loader（论文 §5.2），是 **@zeta-agent/framework 的运行时核心能力**，不是开发期便利工具。它同样服务于 agent 的自演化（运行时替换自身组件），因此其正确性由 A11/A12 验收。

- **HMR**：[framework §8](../framework/components.md#8-组件加载器与-hmr) 的三阶段（发现/构建 → 分类 → 事务重载）+ 单一 `runExclusive` 队列 + readiness barrier + digest 复用 + 模块驱逐（[pi-baseline §3.4](../research/pi-baseline.md)、[10 ENG-5](../research/dsh-optimizations.md#4-工程配置与-ui-优化eng)）。无论开发期还是运行时，变更都走同一路径：watcher 标 dirty → 重建 → 按 id 整块替换 entry → 换 fiber，保留会话与其他插件状态。
- **测试分层**：
  - 单元测试（`bun:test`）：core 语义、agent-core 流水线、插件逻辑；
  - 帧测试（`testRender`）：TUI；
  - 集成测试：完整 turn + 工具 + 会话；
  - 属性测试：`replayConfig` 多种顺序、随机加载/卸载。
- **调试**：`observeDispose` 输出逆调用序列；插件管线可打印 hook 顺序；`assertQuiescent` 可超时诊断不静止的 fiber。


## 6 风险登记与回滚

| 风险 | 阶段 | 触发信号 | 回滚动作 |
| --- | --- | --- | --- |
| 顺序语义漂移 | 2 | 等价测试失败 | 禁用插件管线，回退 legacy 字段 |
| fiber guard 死锁 | 1 | `assertQuiescent` 超时 | 检查 delimiter/realm；启用 drainTimeout 并记错 |
| OpenTUI native 不可用 | 4 | CI 平台不支持 | 用 `--print` 模式；TUI 包声明平台矩阵 |
| 插件缓存无法驱逐 | 5 | HMR 换代码后行为未变 | 改用独立构建产物 URL + vm/digest（[04 O-4](../framework/api-and-testing.md#13-风险与开放问题)） |
| 两套扩展兼容层复杂 | 3/5 | 旧扩展加载失败 | 延后兼容门面到阶段 5；先保内部统一 |
| 权限策略破坏习惯 | 3 | 用户抱怨工具被挡 | 权限门禁默认沿用 pi 无限制行为（[fact-registry C5](../architecture/fact-registry.md#4-矛盾与争议显式并列)）——注意这是**权限维度**，与 O-9（发射交付维度，默认 withhold）不同 |
| 发布产物架构/摘要不匹配 | 发布 | `release-check` 报 BINARY/EMBEDDED_ARCH_MISMATCH 或 SHA-256 不一致 | 停止发布，重建目标产物并按 [release-runbook.md](./release-runbook.md) 回退上一版 |
| 非宿主 target 未实测 | 发布 | 报告中平台门为 skipped | 不写 pass；CI `release-matrix` 36 job 只做构建/静态校验，不提供运行证据；12 target 运行态由 T-24 补齐后再裁决 A36 |


## 7 开放问题与决策点

汇总跨文档开放问题，供用户裁决：

| ID | 问题 | 建议 | 文档 |
| --- | --- | --- | --- |
| O-1 | agent-core 是否运行时依赖 core | 仅类型导入 + 构造注入（已定案，[agent-framework §2](../agent-framework/overview.md#2-包边界与依赖)） | 05 |
| O-4 | Bun 能否稳定驱逐 ESM 缓存 | 实测；不依赖，走独立产物+digest | 04 |
| O-7 | hook priority 默认值与冲突 | 默认 100，冲突按注册序并报告 | 05 |
| O-9 | 发射类工具默认策略 | **已重新建议**（[10 SUP-2](../research/dsh-optimizations.md#5-域层与治理优化sup)）：默认 withhold（事务内 enqueue + commit 后派发 + 幂等键），审计为附带能力；profile 可配置为直接执行以兼容 pi | 06 |
| O-10 | durable 兼容门面是否进第一版 | 否，第二阶段 | 06 |
| O-11 | UI 插件运行时加载 TSX | 第一阶段仅构建期 | 07 |
| O-12 | 是否保留 alt-screen | 实测后定，初始只主屏幕 | 07 |

**需要用户明确决策的只有 O-9（工具副作用默认策略）与 O-4 的实测环境**；其余建议可直接执行。


## 8 交叉引用与验证

| 本文阶段 | 依据文档 | 验证标准 |
| --- | --- | --- |
| 阶段 0 | [framework-model/engineering §3/§5/§8](../architecture/framework-model.md) | A1 |
| 阶段 1 | [04 全篇](../framework/overview.md) | A3/A4/A5 |
| 阶段 2 | [05 全篇](../agent-framework/overview.md)、[pi-baseline §9](../research/pi-baseline.md#9-重构必须保留的不变量清单) | A6 |
| 阶段 3 | [06 全篇](../agent/plugin-system.md) | A7/A8 |
| 阶段 4 | [07 全篇](../agent/tui.md) | A9/A10 |
| 阶段 5 | [framework §8-9 组件与对象运行时](../framework/components.md)、[plugin-system §8/§12](../agent/plugin-system.md) | A11/A12 |
| 理论判据 | [cordis-paper §9](../research/cordis-paper-system.md#9-元理论五条承重保证) | A3/A4/A5 |

**返回索引**：[00 索引与交叉验证](../README.md)


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
