# 迁移路线与验收

> **文档定位**：迁移路线与验收（从 `08-迁移路线与验收.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

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

**不是逐文件翻译 pi**，而是按四层重新划分边界后实现。三条原则：

1. **自底向上**：先 L1（core），再 L2（agent-core），再 L3（agent 插件 + TUI），最后 L4（CLI 装配）。
2. **测试先行**：L2 的 12 条不变量等价测试（[agent-framework §13](../agent-framework/state-and-events.md#13-测试策略与不变量等价清单)）先于插件管线实现；L1 的汇合性/可逆性测试先于 loader/HMR。
3. **双轨兼容**：保留 pi 的字段赋值与两套 Extension 门面作为兼容层（[agent-framework §4.2](../agent-framework/overview.md)、[plugin-system §12](../agent/plugin-system.md#12-两套扩展系统的统一)），老扩展可继续用。

**范围边界**：pi 仓库只读作为事实来源，不在其上修改；新代码写在 `zeta-agent` 工作区（当前为 `bun init` 空项目）。


## 2 阶段计划

### 阶段 0：工程骨架（0.5 天）

**目标**：把当前 `bun init` 空项目变成可运行的 monorepo 骨架。

- 根 `package.json`：`workspaces: ["apps/*","packages/*"]`、`devEngines` 锁 bun 1.4.2、`turbo` 脚本。
- `turbo.json`（[framework-model/engineering §8](../architecture/engineering.md#8-构建任务图turbojson-草案)）、`tsconfig.base.json`、`bunfig.toml`（OpenTUI preload）。
- 建四个包目录与 `apps/zeta-cli` 的最小 `package.json` / `tsconfig`。
- 安装锁定：`solid-js@^1.9.16`、`@opentui/core@0.9.3`、`@opentui/solid@0.9.3`、`turbo@<pinned>`、`esbuild`（可选 peer）。

**退出条件**：`bun install` 成功；`turbo run build/typecheck/test` 空任务全绿；依赖图无环。

### 阶段 1：`@zeta-agent/framework` 内核（2-3 天）

**目标**：ctx.effect / fiber 状态机 / coeffect / registry 可运行并通过论文判据测试。

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

**目标**：开发期热重载、跨进程对象、受控自演化。

- [framework §8](../framework/components.md#8-组件加载器与-hmr)：三阶段 HMR（先做构建+digest+事务重载，跨 host rollout 后置）。
- [framework §9](../framework/components.md#9-对象运行时与跨进程边界可选子路径)：contract/document/store/link 最小实现（可选子路径）。
- [plugin-system §8](../agent/plugin-system.md#8-自演化与安全管理)：自演化护栏（required root、环检测、沙箱、试加载回滚）。
- [plugin-system §12](../agent/plugin-system.md#12-两套扩展系统的统一)：pi 两套 Extension 兼容门面。
- **护栏强化**（来自 [recursive-self-evolution.md §6](../research/recursive-self-evolution.md#6-落地批次)）：晋升 digest 校验、workspace 不覆盖 + RESUME、stage-scoped 权限、grader tripwire、预算恒等式——即便不做完整递归自演化，这些也强化受控热替换。

**退出条件**：改一个插件文件 → 不重启进程即生效，且其他插件的会话/连接保留；故障注入（语法错误）能回滚；自修改试加载失败不影响宿主。

### 阶段 6：递归自演化研究轨（可选/后续）

**定位**：产品轨阶段 1-5 不实现自动代码生成与部署；但框架已在阶段 5 预留所需 seam。研究轨仅在有可重放任务+评估器时启用。

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
| A6 | 12 条 agent-core 不变量的 legacy/plugin 双版测试全绿 | 24 个测试报告 | 2 |
| A7 | 工具热插拔后 transcript 声明同步；权限策略热更新不 reload | 集成测试 | 3 |
| A8 | 工具副作用分类审查通过；发射类默认策略符合配置 | 工具清单审查 | 3 |
| A9 | `testRender` 帧快照覆盖消息/工具/状态/overlay/槽位热替换 | 帧快照测试 | 4 |
| A10 | `--print/--json/--rpc` 在无 TTY 下完整可用 | CI 冒烟 | 4 |
| A11 | 插件文件变更不重启生效；故障注入可回滚（阶段 5） | HMR 测试 | 5 |
| A12 | 自修改试加载失败不影响宿主（阶段 5） | 故障注入 | 5 |
| A13 | 五模式派发与 `interface Events` 声明一致；单调 guard 任意顺序下 deny 不翻回 allow | 声明合并类型测试（`@ts-expect-error`）+ 排列测试（[10 CORE-1/6](../research/dsh-optimizations.md#3-核心运行时优化core)） | 0-2 |
| A14 | same config 不同顺序 → `--dump-config` 输出观察等价；patch 按 id 整块替换可复现 | 汇合测试 + patch 测试（[10 CORE-14/ENG-2](../research/dsh-optimizations.md#4-工程配置与-ui-优化eng)） | 0-1 |
| A15 | effects 插件：进程崩溃重启后 durable intent 被重放且幂等键不产生重复 | 故障注入 + 重启测试（[10 SUP-1/2](../research/dsh-optimizations.md#5-域层与治理优化sup)） | 3 |
| A16 | 晋升单调性：incumbent 参赛，新策略仅严格更优且资格合格才替换 | 候选竞争测试（[SE-D6](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A17 | 重放不变量：budget===order.length、无重复、每步 isLegal、best≤runBest | 框架级断言（[SE-D10](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A18 | 观察等价晋升：晋升前后 ctx 在键上的公开操作测试一致 | 汇合性扩展测试（[SE-H3](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 5-6 |
| A19 | 无 ground truth：grader verdict / rubric / score 不进改进上下文，tripwire 命中即抛错 | 泄漏注入测试（[SE-H8](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 5-6 |
| A20 | 递归不破坏不变量：自演化前后 24 条不变量等价测试全绿 | 不变量回归（[SE-H11](../research/recursive-self-evolution.md#5-对现有设计的优化建议)） | 6 |
| A21 | 可观测性：日志含 runId/fiber 归因；OTLP 故障降级本地；敏感字段脱敏；观测不破坏 Thm 80 | [observability.md](../framework/observability.md) 契约测试 | 2-3 |
| A22 | 执行隔离：工具调用走 ExecutionBackend；capabilities() 关键层降级即 FAILED；凭证不进日志/snapshot | [security.md](../agent/security.md) 能力探测 + 凭证测试 | 3-5 |
| A23 | egress 与审计：发射目标白名单默认拒绝；进程外 AuditSink 带 finalized 完整性标记 | [security.md §4/§6](../agent/security.md) 门禁 + 审计测试 | 3-5 |
| A24 | 官方源码对照：@mode 措辞、HMR 按 unit 部分提交、撤销两层语义与 cordis 官方一致 | [cordis-source-verification.md](../research/cordis-source-verification.md) 对照检查 | 0-2 |


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
| 权限策略破坏习惯 | 3 | 用户抱怨工具被挡 | 默认沿用 pi 无限制行为（[06 O-9](../agent/plugin-system.md#13-风险与开放问题)） |


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
| 阶段 5 | [framework §8-9](../framework/overview.md)、[plugin-system §8/§12](../agent/plugin-system.md) | A11/A12 |
| 理论判据 | [cordis-paper §9](../research/cordis-paper-system.md#9-元理论五条承重保证) | A3/A4/A5 |

**返回索引**：[00 索引与交叉验证](../README.md)


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
