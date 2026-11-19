# 基于 DSH 的设计优化

> **文档定位**：基于 DSH 的设计优化（从 `10-基于DSH的设计优化.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [1 结论速览与事实校正](#1-结论速览与事实校正)
- [2 优化建议总表](#2-优化建议总表)
- [3 核心运行时优化（CORE）](#3-核心运行时优化core)
- [4 工程、配置与 UI 优化（ENG）](#4-工程配置与-ui-优化eng)
- [5 域层与治理优化（SUP）](#5-域层与治理优化sup)
- [6 落地批次与验收](#6-落地批次与验收)
- [7 对既有文档的修订清单](#7-对既有文档的修订清单)
- [8 交叉引用与验证](#8-交叉引用与验证)

## 1 结论速览与事实校正

### 1.1 最重要的发现

**S12 是论文的复刻蓝本，不是运行时依赖。** 它的 [docs/architecture.md:9-11](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L9-L11) 明确：*"Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself… **There is no privileged core to patch**"*。这把我们的设计从"基于论文的推断"提升为"有生产参考的实现路径"。

**由复刻定位推出的一条结构性结论**：S12 中一切通用机械——五模式事件系统、scope、seam/registry、loader、配置分层（profile/bundle/patch）、HMR、HealthBoard——都必须由我们自己实现并归入 **L1 `@zeta-agent/framework`**（论文 core library + component loader 两层），而不是当作外部依赖或上层增强。HMR 尤其如此：论文 §5.2 把"配置对账 + 热模块替换"列为 Cordis 的第二层，chord 也强调"没有 dev/prod 之分"。因此 [doc §5](../delivery/roadmap.md#5-运行时-hmr-与测试) 已从"开发期体验"改名为"运行时 HMR"。

它同时暴露了我们设计的四个**实质性缺口**：

1. **事件只有一种语义**。我们 05 的 `AgentEvent` 全部"按序 await listener"；S12 有 `emit/parallel/serial/bail/waterfall` 五种，并且把派发模式作为**静态校验的公共契约**（`@mode` 标签 + `verify-cordis-catalog`）。
2. **权限链可被提权**。我们 05 §9 用 `beforeToolCall` 链做权限，后执行的 listener 可以把先前的 `block` 翻回允许；S12 用**单调 guard（只有 deny 没有 allow）**从类型上杜绝。
3. **disposer 只保证"调用一次"不够**。S12 的真实 bug 场景：包装 disposer 会让注销 agent 变成并发兄弟，在最后一个 turn 还在 drain 时就触发 `agent/disposed`。**exact disposer 身份是 load-bearing**。
4. **配置只有单一 entry 列表**。S12 用 `profile → bundle → profile patch → home patch → --patch` 的有序层 + 按 id 整块替换 + `--dump-config`，这才让论文 Thm 80 的"最终配置决定最终状态"可工程化。

### 1.2 事实校正（纠正我们此前的推断）

| 此前说法 | 校正 | 来源 |
| --- | --- | --- |
| "pnpm catalog 值得借鉴" | S12 的 `pnpm-workspace.yaml` **没有** catalog 段；真正机制是 `overrides`/`peerDependencyRules.allowedVersions`/`allowBuilds`/`patchedDependencies`/`minimumReleaseAgeExclude` | S12 `pnpm-workspace.yaml` |
| "权限预设在 `packages/preset/permission-presets`" | 实际在 `packages/interaction/permission-presets` | S12 路径 |
| "HMR 用 backup 回滚是必要复杂度" | S12 不做备份驱逐，失败即停旧插件并报 `failed`，保持 inactive 等修正；我们的 backup 方案可简化 | S12 `packages/boot/hmr/README.md` |
| "Cordis 的 isolate 只做可见性" | S12 的 `isolate(name,label)` 是**断开父级回退 + 新建 realm**，未供给前读取抛错；比我们 04 §6.2 的描述更强 | S12 [vendor/cordis/src/context.ts:111-130](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/context.ts#L111-L130) |
| "symbol key 是唯一方案" | S12 用**字符串 `ctx.*` + declaration merging**，使配置文本可 patch；建议两种键并用 | S12 [packages/fs/fs/src/index.ts:53-95](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs/src/index.ts#L53-L95) |

### 1.3  unaffected 的设计

我们 03 的 P1/P2/P3/P4/P5/P6/P8/P9/P10 与 S12 实现方向一致；04 的 fiber 状态机、guard、LIFO、HMR 三阶段骨架正确；05 的 12 条不变量与 S12 的约束高度吻合。优化主要是**补语义深度**，不是推翻架构。


## 2 优化建议总表

| ID | 优先级 | 建议 | 目标文档节 |
| --- | --- | --- | --- |
| CORE-1 | P0 | 事件派发模式升为一等公民（5 种 + `@mode` 静态校验） | 05 §3.1/§4.2/§10 |
| CORE-2 | P0 | exact disposer 身份写进契约；断言嵌套 yield 位置 | 04 §4.2/§11，05 §3.4 |
| CORE-3 | P1 | volatile / material 配置分类 + loader/volatile-update | 04 §8.2 |
| CORE-4 | P1 | `Scoped<T>` carrier + scope-filtered 事件 + 双路径 teardown | 04 §6.2，05 §9 |
| CORE-5 | P0 | discriminated Decision union 取代 transform input | 05 §4.2/§5.2 |
| CORE-6 | P0 | 单调 guard：只有 deny 没有 allow | 05 §8/§9 |
| CORE-7 | P1 | `isConcurrencySafe(args)` fail-closed 并行 | 05 §8 |
| CORE-8 | P1 | inbox 双队列 + `agent.inject()` + MessageId | 05 §3.4/§5.2，02 §9 |
| CORE-9 | P1 | Agent vs AgentHandle + 二态 status + whenIdle/runMaintenance | 05 §3.4/§10 |
| CORE-10 | P1 | 强制 `output` 契约 + schemas allowlist | 05 §3.3/§8 |
| CORE-11 | P1 | surface append/replace + message projection | 05 §11/§12 |
| CORE-12 | P1 | 三条工具流水线不变量固化（参数不可重写等） | 05 §8/§13 |
| CORE-13 | P1 | seam 三段式登记 + 生成式能力图 | 03 §6.2，04 §10，05 §12 |
| CORE-14 | P0 | profile/bundle/patch 分层 + `--dump-config` | 04 §8，03 §4.4/§9 |
| CORE-15 | P2 | 字符串 key + declaration merging 与 symbol key 并用 | 03 §6.2，04 §3.1 |
| CORE-16 | P1 | effect label + getEffects + 声明-派发一致性校验 | 04 §11，05 §4.2 |
| ENG-1 | P0 | ordered patch layers → 派生 entry 集合 | 04 §8，03 §4.4 |
| ENG-2 | P0 | PatchOptions 按 id 整块替换 + name 断言 + 来源归因 | 04 §8.1/8.2 |
| ENG-3 | P1 | preset 内层 entry list + 同层 patch | 06 §4，04 §8 |
| ENG-4 | P1 | manifestVersion + engines 风格兼容性预检 | 04 §8，03 §7 |
| ENG-5 | P1 | HMR 单一 runExclusive 队列 + readiness barrier | 04 §8.4，03 O-4 |
| ENG-6 | P2 | 数据-only launcher facts | 03 §4.4，04 §3.3 |
| ENG-7 | P1 | ConversationNodeDefinition 式 signal 桥 | 07 §4，08 验收 |
| ENG-8 | P1 | 槽位声明合并 + cardinality/scope + inject 生命周期回调 | 07 §5/§8 |
| ENG-9 | P2 | UI manifest + boot graph + 单一 renderSlot 挂载点 | 07 §10，06 §10 |
| ENG-10 | P0 | per-call policy + enforcement 事实 + 审批 fail-closed | 06 §6/§7 |
| ENG-11 | P2 | permission presets（sandbox/approval 双旋钮） | 06 §7 |
| ENG-12 | P1 | required-entry 启动审计 + 失败矩阵 + 唯一诊断出口 | 06 §13，04 §7.4 |
| ENG-13 | P1 | 架构守护脚本 + gen/verify 成对校验 | 03 §8/§12 |
| ENG-14 | P2 | 供应链约束（deny-by-default 构建白名单等） | 03 §3/§8 |
| ENG-15 | P1 | seam 三角色 + 同 execution world 一次换整族工具 | 06 §9，04 §9 |
| ENG-16 | P2 | 插件市场生成器与宿主解耦 | 新增节 |
| SUP-1 | P0 | 新增 effects 服务插件（事务内 enqueue、commit 后派发、幂等/退避/health） | 06 §6/§5，04 §5.2 |
| SUP-2 | P0 | 默认 withhold + 幂等键，替代 O-9 的"直接执行+审计" | 06 §6/§13，08 §7 |
| SUP-3 | P1 | atomic/afterCommit 双层 + WAL | 06 §5/§11 |
| SUP-4 | P1 | 一等 Mandate + revalidate，"消息是数据不改权限" | 06 §7 |
| SUP-5 | P1 | policyVersion/policyChanged，不撤销在途授权 | 06 §8，05 §9 |
| SUP-6 | P1 | bundle patch 定义 worker/router 两套 preset | 06 §2/§3/§11 |
| SUP-7 | P1 | 硬裁剪 + 软拦截双层能力衰减 | 06 §3/§7 |
| SUP-8 | P1 | state → 唯一 writer 表 + HealthBoard 式断言 | 03 §6，04 §10 |
| SUP-9 | P1 | 命令式/过去式命名 + 固定拒绝码 | 05 §3.4/§4.2 |
| SUP-10 | P1 | 带类型 DomainEvent + 单一 emit | 05 §10，04 §10 |
| SUP-11 | P2 | 幂等消息投递跨重启 | 05 §10/§11 |
| SUP-12 | P1 | 结构化 Attention 等人工 | 06 §6/§8，05 §8 |
| SUP-13 | P1 | schema 只增 + 迁移 + 试加载回滚 | 06 §8，08 §5/§6 |
| SUP-14 | P2 | 拒绝概念表 + 5 级提示词优先级 | 06 §1/§4/§7 |
| SUP-15 | P2 | health 三阈值 + quiet | 06 §8/§13，08 §4 |


## 3 核心运行时优化（CORE）

### CORE-1（P0）事件派发模式升为一等公民
- **现状**：05 §3.1 的 10 种事件全部按序 await listener；05 §4.2 `HookChain.run` 只有一种"依次 await 并 transform input"。
- **建议**：定义 `DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`，每个事件声明带 `@mode`；把 HookChain 拆成 `serial`（无 next）与 `waterfall`（around + next，缺 next 短路）两种原语。映射建议：`message_end`/`tool_execution_end`→emit、`beforeToolCall`/`afterToolCall`/`prepareRequest`→waterfall、`agent_end` 屏障→serial。加构建期脚本校验声明与派发点一致（仿 `verify-cordis-catalog`）。
- **来源**：S12 [docs/cordis-primer.md:15-35](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md#L15-L35)、[vendor/cordis/src/events.ts:193-265](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/events.ts#L193-L265)、[docs/subsystems/core.md:108](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L108)。
- **理由**：这是 CORE-5/6 的语义基础，也是 02 §9 不变量 #1（message_end 屏障）与 #6（no-throw）的承载机制。

### CORE-2（P0）exact disposer 身份是 load-bearing
- **现状**：04 §4.2 只保证 LIFO、一次性；05 §3.4 每个注册返回 disposer。
- **建议**：`Disposer` 做成 branded exact identity；文档明确"复合 generator effect 必须直接 yield 底层返回的那个 disposer，不能 yield 包装函数"；`assertNoResidue` 增加断言"teardown 位于正确 yield 位置（嵌套顺序）"，而不只是调用次数。
- **来源**：S12 [docs/subsystems/core.md:790-799](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L790-L799)、[vendor/cordis/src/fiber.ts:443-470](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/fiber.ts#L443-L470)（`disposables.splice(0).reverse()`）。
- **理由**：S12 的真实 bug：包装 disposer 导致注销 agent 成为并发兄弟，在最后一个 turn 仍 drain 时触发 `agent/disposed`。这是 P5 guard 的细化。

### CORE-3（P1）volatile / material 配置分类
- **建议**：`Entry` 字段增加 `volatile?: boolean`；volatile 变更走 `reflect.notify` 直接更新运行中 fiber（不 remount、不重解析依赖），material 才走 L-Begin→L-Unload；补测试"volatile 更新不触发 reload"。
- **来源**：S12 [docs/cordis-api/inherited.md:27-28,39](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/inherited.md#L27-L28)、[docs/architecture.md:27](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L27)。
- **理由**：我们 04 §8.2 只说"组件自己 diff"，缺框架级分类。

### CORE-4（P1）Scoped<T> 与 scope-filtered 事件
- **建议**：在 `CoeffectKey` 之外加 `ScopeKey`/`Scoped<T>` 与 `scopeTarget(base,key)`；事件声明支持 `this: Scoped<T>`，派发按 key 过滤 listener；`Scope` 提供 `rawDispose`（精确身份）+ `dispose`（共享静止）双路径。
- **来源**：S12 `packages/core/scope/src/index.ts`、[docs/subsystems/scope.md:9-43](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/scope.md#L9-L43)、[docs/subsystems/core.md:852-866](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L852-L866)。
- **理由**：我们的 `ctx.isolate` 只解决"读哪个实现"，没解决"哪个 agent 的事件该被谁看到"；多 agent/subagent 场景必需。

### CORE-5（P0）Decision union 取代 transform input
- **建议**：每类拦截定义 kind 标签 union：`PreStepDecision = reject | enter{messages, startsRequestSeries?}`、`PreToolDecision = allow|deny|cancel|ask`、`PostToolDecision = accept{content xor value}|block{feedback}`；hook 只返回 decision，不直接改 input。包装 listener 必须用 `{...decision, messages}` 保留声明字段。
- **来源**：S12 [docs/subsystems/tools.md:541-570](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L541-L570)、[docs/subsystems/core.md:387-404](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L387-L404)。
- **理由**：transform 链无法表达拒绝/短路/保留声明，且容易丢字段。

### CORE-6（P0）单调 guard
- **建议**：新增 `ToolGuard = (exec) => string | ToolGuardDenial | undefined`；`undefined` 保留 waterfall 决定，返回 reason **只能收紧权限**；`beforeToolCall` 的 block 属可协商 waterfall，guard 是不可翻回的否决。补不变量测试"任意 listener 顺序下 deny 不会变回 allow"。
- **来源**：S12 [docs/subsystems/tools.md:458-479](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L458-L479)、[docs/tool-execution-pipeline.md:13-15](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md#L13-L15)。
- **理由**：类型上禁止权限提升，比运行时约定可靠。

### CORE-7（P1）条件并行 fail-closed
- **建议**：`executionMode` 升级为 `{kind:'parallel'}|{kind:'exclusive'}`，引入 `isConcurrencySafe?(args): boolean`，**只有严格 true 才并行**；叠加全局 `maxParallelToolCalls`。
- **来源**：S12 [docs/subsystems/tools.md:71-85,388-398](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L71-L85)。
- **理由**：静态模式无法区分具体参数是否安全；fail-closed 避免并发写冲突。

### CORE-8（P1）inbox 双队列
- **建议**：durable projection：`nextTurn`/`nextStep` 两个有序列表，每条带 `MessageId`；`append/prepend/replace/remove/splice/clear` 与 `inserted/claimed/discarded` 事件；`inject()` 排 next-step 且不唤醒；`startsRequestSeries` 进 pre-step decision。
- **来源**：S12 [docs/subsystems/core.md:107-144,280-344](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L107-L144)、[docs/architecture.md:161](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L161)。
- **理由**：把 02 §9 不变量 #4/#5 从注释约束变成可机械验证的事件。

### CORE-9（P1）Agent 访问权 vs AgentHandle 所有权
- **建议**：`create/resume` 返回 `{agent, dispose}`；`get(id)` 只返回裸 Agent；`cancel(cause,{keepInbox?})` 带类型化 cause；`status:'idle'|'running'`（销毁走 `agent_disposed` 事件）；提供 `whenIdle()` 与 `runMaintenance()`。
- **来源**：S12 [docs/subsystems/core.md:26-47,53-196](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#L26-L47)。
- **理由**：我们让任何持有 ctx 的插件都能拆 agent；dsh 把所有权做成 capability，把静止做成显式 API。

### CORE-10（P1）强制 output 契约 + schema allowlist
- **建议**：`output` 从可选升为强制 `{schema, render, presentationMeta?}`；`execute` 只返回 JSON value，由 registry 校验/render；`schemas()` 只投影 name/description/parameters；错误走结构化 `ToolErrorInfo{name,code,reason?}`。
- **来源**：S12 [docs/subsystems/tools.md:9-12,27-106,159-161](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L9-L12)。
- **理由**：让 replay/presentation 可重建，避免"knowledge 留在工具实现里"。

### CORE-11（P1）surface append/replace + message projection
- **建议**：会话事件加 `surfaceOp:'append'|{op:'replace',startSeq,endSeq}` 与 `ignorable?`；改内容的插件注册纯 `SessionMessageProjection`；prompt 渲染结果作为 `system/message` surface node（首步 node 0），保留 `contentGeneration` 供增量消费者识别重写。
- **来源**：S12 [docs/subsystems/session.md:319-398](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md#L319-L398)、[docs/subsystems/system-prompt.md:44-46](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md#L44-L46)。
- **理由**：把 02 §9 不变量 #12 从约定变成可离线重放的语义。

### CORE-12（P1）固化三条工具流水线不变量
- ① arguments 入日志后不可重写（history/audit/UI/execution 一致）；② post 只能替换 content **或** value 之一（union 互斥、`value?: never`）；③ `concludesTurn/terminate` 只有权威成功结果能传播，组合工具必须转发嵌套结果。
- **来源**：S12 [docs/subsystems/tools.md:572-574](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#L572-L574)、[docs/tool-execution-pipeline.md:64](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md#L64)。

### CORE-13（P1）seam 三段式登记 + 生成式能力图
- **建议**：建 `seam-catalog`，每个 key 标注 `{role: core|seam|service, definition, providers[], consumers[], note}`；脚本从 declaration merging 生成 mermaid 图与表格，校验"每个 seam 至少 1 provider + 1 consumer"。
- **来源**：S12 [docs/architecture.md:136-142](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L136-L142)、[docs/capability-seams.md:668-723](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md#L668-L723)。
- **理由**：识别"定义了但没人能换"的伪 seam。

### CORE-14（P0）profile/bundle/patch 分层
- **建议**：CLI 增加 `--profile` + 有序 patch 文件 + `--dump-config`；bundle 用 `package.json` 的 `zeta.profile`/`zeta.bundle` 声明；patch 按 id 整块替换或插入；loader 增加 `--patch` overlay 与 HMR 开关。
- **来源**：S12 [docs/architecture.md:13-39](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L13-L39)、[apps/cli/reference/README.md:13-21](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#L13-L21)。
- **理由**：这是 Thm 80 汇合判据的工程载体。详见 ENG-1/2。

### CORE-15（P2）字符串 key + declaration merging 与 symbol key 并用
- **建议**：保留 symbol key 的类型安全，同时生成 `declare module '@zeta-agent/framework' { interface Context { tools: ToolsService }; interface Events {...} }`；用 `class XxxService extends Service { constructor(ctx){ super(ctx,'name') } }` 统一占键模式。
- **来源**：S12 源码 [packages/fs/fs/src/index.ts:53-95](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs/src/index.ts#L53-L95)、[packages/subagent/subagent/src/index.ts:131-168](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/index.ts#L131-L168)、[packages/llm/llm/src/index.ts:58-79](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts#L58-L79)。
- **理由**：纯 symbol 键无法被 YAML patch 引用；两者兼得。

### CORE-16（P1）可观测性三件套
- `ctx.effect(callback, label?)` 增 label，`getEffects()` 返回带 label 的诊断树；`verify-declarations` 脚本校验事件 `@mode` 与派发点、seam 三方齐备；`--dump-config` 输出纳入汇合测试。
- **来源**：S12 [vendor/cordis/src/fiber.ts:439-441,472](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/fiber.ts#L439-L441)、[docs/cordis-primer.md:27](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md#L27)、[docs/architecture.md:33-37](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L33-L37)。


## 4 工程、配置与 UI 优化（ENG）

### ENG-1（P0）ordered patch layers → 派生 entry 集合
- **建议**：把 04 §8 的手写 entry 列表升级为 `profile bundles → profile patch → home patch → --patch` 四层；层作用于**空 entry 列表**；row 顺序不承载加载语义（激活由 service 可用性驱动）。
- **来源**：S12 [docs/architecture.md:13-39](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L13-L39)、[packages/boot/app-boot/src/profile-context.ts:74-85](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/profile-context.ts#L74-L85)。

### ENG-2（P0）PatchOptions 引擎
- **建议**：按 id 整块替换（**非深合并**）+ `name` 断言不一致则跳过告警 + `insert` 可插入 group 的 `config`；保留 `EntryOwner` 来源归因支撑 `--dump-config`；`!!js` 表达式支持平台条件。
- **来源**：S12 [vendor/include/src/patch.ts:5-16,47-145](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/include/src/patch.ts#L5-L16)、[packages/bundle/base/cordis.patch.yml:1-13](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml#L1-L13)。

### ENG-3（P1）preset 内层 entry list
- **建议**：`config.plugins` 视为 entry list，同一 PatchOptions 递归按 id 覆写；`agent preset` 用 `mount(ctx,id?)` + revision lease + `composeFrom(parent)` 保证 fork/resume 用同一 revision。
- **来源**：S12 [docs/architecture.md:25](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L25)、[packages/bundle/web-app/presets/minimal.patch.yml:1-3](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/presets/minimal.patch.yml#L1-L3)、[packages/preset/agent-preset-registry/src/mount.ts:204-209](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset-registry/src/mount.ts#L204-L209)（preset patch 实现为有证据推断）。

### ENG-4（P1）组合边界兼容性预检
- **建议**：`manifestVersion` + `engines.zeta-agent` 风格单一运行时版本；精确豁免写在 profile 的 `compatibility.json`（升级不继承）；`bundle.platforms` 在读取 patch 前校验并记 `skippedBundles`。
- **来源**：S12 [packages/util/package-manifest/src/types.ts:31-41](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/package-manifest/src/types.ts#L31-L41)、[packages/boot/app-boot/README.md:54-58](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md#L54-L58)。
- **注意**：这是组合边界门禁，不是沙箱。

### ENG-5（P1）HMR 单一队列 + readiness
- **建议**：用单一 `runExclusive` 协调 file/config/package 三类变更（拒绝嵌套事务，包安装走队列外）；`appReady.onReady` barrier；inode/size/mtime 比较（不只看 mtime）；namespace 身份追踪；考虑取消 backup，失败即保持 inactive。
- **来源**：S12 [packages/boot/hmr/README.md:27-83](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/hmr/README.md#L27-L83)、[packages/boot/hmr/src/index.ts:55-65,367-373](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/hmr/src/index.ts#L55-L65)。
- **注意**：dsh 依赖 Node loader internals，Bun 不可照搬；只借鉴队列/readiness/比较策略，模块驱逐仍用我们的独立 URL + digest 方案（03 O-4）。

### ENG-6（P2）数据-only launcher facts
- **建议**：`ProfileContextLike` 只含 name/paths/startedBundles/overlays/telemetry 开关等数据；调度与写操作归调用方。
- **来源**：S12 [packages/boot/app-boot/src/profile-context.ts:1-37](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/profile-context.ts#L1-L37)。

### ENG-7（P1）ConversationNodeDefinition 式 signal 桥
- **建议**：UI 更新逻辑定义 `{kind, target, match(event)→{id,role,exclusive?}, start/update, publication:'immediate'|'animation-frame'|'none', buildViewNode}`；稳定 `(kind,id)` 作身份；窗口更新支持 replace/prepend/append 与失败整窗重建；性能不变量"一条事件只做 D 次 match + 常数查表，禁止遍历全窗"。
- **来源**：S12 [docs/subsystems/conversation.md:15-22,171-243,246-287](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md#L15-L22)。
- **理由**：比我们 07 §4 的朴素 signal 映射更可测试，且天然支持 compaction/替换历史。

### ENG-8（P1）槽位声明合并 + 生命周期回调
- **建议**：`SlotMap` 声明合并，带 cardinality `single|list|keyed|chain|hoc` 与 scope `root|session-maybe|session`；跨包用 `ctx.slots.inject(key, callback)`，回调按 owner 声明生命周期，owner 折叠时移除其 effect；明确"组件不接收 ctx/transport/其他插件实现"。
- **来源**：S12 [docs/subsystems/slots.md:19-52,54-69,85-101](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md#L19-L52)、[docs/subsystems/web-client.md:9-20](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md#L9-L20)。
- **理由**：把 07 §8 的 onCleanup=逆具体化为可声明的归属语义。

### ENG-9（P2）UI manifest + boot graph
- **建议**：UI 插件独立 manifest（platform/inject/immediately/external）+ boot graph（entries/batches/rev）；settled + 启动审计后由**唯一 context 级** `renderSlot('root')` 挂载；无 TUI 形态也保留清单。
- **来源**：S12 [packages/util/package-manifest/src/types.ts:86-100](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/package-manifest/src/types.ts#L86-L100)、[docs/subsystems/client-modules.md:13-39,92-124](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md#L13-L39)、[docs/subsystems/web-client.md:22-28](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md#L22-L28)。

### ENG-10（P0）权限三件套
- **建议**：① per-call policy 值传递（workspaceRoot/sessionId/additionalWritableRoots）；② `enforcement:'full'|'partial'` 事实化，partial 不得当绝对边界；③ 审批 fail-closed 四态 `allowed-once|rejected|cancelled|unavailable`，缺失/抛错一律 unavailable；approval 是 answerer waterfall，成对审计事件。把 beforeToolCall 策略改成 capability 事件监听者。
- **来源**：S12 [docs/subsystems/sandbox.md:11-102,164](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md#L11-L102)、[docs/subsystems/approval.md:9-49](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md#L9-L49)、[docs/tool-execution-pipeline.md:4-64](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md#L4-L64)。
- **理由**：直接补强 06 §6/§7，且确立"confine 失败绝不静默放行"。

### ENG-11（P2）permission presets
- **建议**：一个插件把 sandbox/approval 两旋钮捆成具名档位 + `defaultPreset` + `permission/preset` 日志事件；值仍由各自 service 拥有，删插件后保留最后选择。
- **来源**：S12 [packages/interaction/permission-presets/README.md:30-60,83-99](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/README.md#L30-L60)。

### ENG-12（P1）启动审计与失败矩阵
- **建议**：required entry 启动失败 → dispose 全 app + `StartupError` + exit 1；optional 仅告警；HMR 阶段不重跑 required 审计、不整体回滚；唯一诊断出口（日志含源码与原因）。
- **来源**：S12 [packages/boot/app-boot/README.md:95-117](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md#L95-L117)、[apps/cli/reference/README.md:74-81](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#L74-L81)。

### ENG-13（P1）架构守护脚本
- **建议**：白名单式"唯一应用入口"检查（`MANIFEST_BIN_ALLOWLIST` 等，防止绕过 loader 的 bin/demo）；gen/verify 成对的配置目录与 catalog 生成校验；纳入 `check-all` 门禁。
- **来源**：S12 [scripts/verify-application-entrypoints.ts:21-62](https://github.com/deepseek-ai/deepseek-harness/blob/master/scripts/verify-application-entrypoints.ts#L21-L62)、[package.json:88-98,147-225](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json#L88-L98)。
- **理由**：落地我们 03 §12 的"依赖图无环/入口统一"验收。

### ENG-14（P2）供应链约束
- **建议**：deny-by-default 构建脚本白名单（只放行 esbuild 等）、依赖 override/patch 表、release-age 例外；在 Bun 侧找对应机制，找不到则记为缺口。
- **来源**：S12 [pnpm-workspace.yaml:17-124](https://github.com/deepseek-ai/deepseek-harness/blob/master/pnpm-workspace.yaml#L17-L124)、[AGENTS.md:130-145](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md#L130-L145)。

### ENG-15（P1）同 execution world 换整族工具
- **建议**：fs 与 subprocess/terminal 共享一个 execution world；切到远程 sandbox 时 Bash/PTY/LSP 一次带走，无需 fork provider。
- **来源**：S12 [docs/architecture.md:136-142](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L136-L142)、[packages/subprocess/README.md:12-31](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subprocess/README.md#L12-L31)、[packages/fs/README.md:38](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/README.md#L38)。

### ENG-16（P2）插件市场生成器解耦
- **建议**：生成器做独立 CLI（只读包元数据、产 `index.json`，不执行插件代码）；reader 端持有 indexes volatile 配置 + 只读 agent tool；安装统一走 manager（带审批与 HMR 串行）。
- **来源**：S12 [apps/plugin-market-generator/README.md:5-42](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/plugin-market-generator/README.md#L5-L42)、[packages/boot/plugin-market/README.md:12-83](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-market/README.md#L12-L83)、[packages/boot/plugin-manager/README.md:124-130](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md#L124-L130)。


## 5 域层与治理优化（SUP）

> 来源是 S13（dsh-superagent-prototype）。它展示了在 everything-is-a-plugin 的 harness 之上，如何再叠一层"组织级/主管级"域模型与治理。我们 06 的"自演化 agent"最终会走到这一层。

### 5.1 三个最重要的补强

1. **durable effects 是我们 [plugin-system §6] 缺失的那一半**。我们正确识别了论文的 acquisition/emission 边界，但把 emission 交付留在"策略声明"层（O-9 甚至建议默认"直接执行+审计"）。S13 的 `Effects` 把它落成机制：事务内 `enqueue(kind,key,payload)`、commit 后 dispatch、`(kind,key)` 唯一、保留 `seq` 队列位置、`generation` 守卫防误删、指数退避、`Later` 表示"正常等待不算失败"、连续 3 次失败才报 health error。这才是论文 "withhold / output commit" 的可执行定义，也是我们 `AgentTool.replay: "never"|"safe"` 的落点。
2. **"一次写入者 + 窄接口"从文档规则变成运行时不变量**。S13 的 `HealthBoard.claim()` 对重复 claim 直接抛错；`EngineFor<Role> = Pick<Engine,...>` 让每个调用方只看到自己需要的命令。我们 03 §6 只有包依赖方向，缺**运行状态写入权表**。
3. **结构化治理取代自由文本推断**。`Attention{id,question,triggerId}` + `waitsForPerson` + `followupOwners` + `handback` 把"等人工"变成可判定的事实；S13 明确把"从报告自由文本推断 waiting"列为**拒绝概念**。

### 5.2 建议清单

| ID | 优先级 | 建议 | 目标节 | S13 来源 |
| --- | --- | --- | --- | --- |
| SUP-1 | P0 | 新增 `effects` **服务插件**（不放 core，core 必须无 I/O）：`enqueue` 事务内、commit 后 dispatch、`(kind,key)` 唯一、`seq` 保序、`generation` 防覆盖、指数退避、`Later` 不计数、每 kind 一 handler、3 次阈值 health | 06 §6/§5，04 §5.2 | `src/app/effects.ts`；`docs/003-execution.md` "Stored work" |
| SUP-2 | P0 | 把 06 O-9 的默认"直接执行+审计"改为**默认 withhold（事务内 enqueue、commit 后执行）+ 幂等键**；审计是附带能力 | 06 §6/§13，08 §7 O-9 | [src/app/outbox.ts:26-37](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/outbox.ts#L26-L37)；[docs/007-architecture.md:166-181](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L166-L181) |
| SUP-3 | P1 | 会话插件增加 `atomic()`（嵌套 SAVEPOINT）+ `afterCommit()` 双层：内存跟随用 afterCommit，跨崩溃副作用用 Effects；WAL + synchronous=FULL | 06 §5/§11，04 §5.1 | [src/app/store.ts:58-64,133-162](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/store.ts#L58-L64) |
| SUP-4 | P1 | 一等不可变 `Mandate` + `MandateBasis` + `revalidate`，"消息/提示词是数据，不能改权限"写入 [plugin-system §7] 前置条款 | 06 §7 | [src/core/model.ts:116-133](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/model.ts#L116-L133)；[src/policy.ts:167-240](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/policy.ts#L167-L240)；[docs/002-authorization.md:5](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md#L5) |
| SUP-5 | P1 | `policyVersion/policyChanged/policyEffects`：变更只通知受影响 Ticket（`policy-changed` Input），**不撤销在途 Mandate**，重排运行中 Eval | 06 §8，05 §9 | [src/policy.ts:111-165](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/policy.ts#L111-L165)；[src/core/engine.ts:255](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/engine.ts#L255) |
| SUP-6 | P1 | 用 bundle patch 定义 worker/router 两套 preset + `order` + `group/isolate`，插件清单从 TS 常量移到可被 profile 覆盖的层 | 06 §2/§3/§11，05 §4 | [cordis.patch.yml:4-20,121-132](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/cordis.patch.yml#L4-L20)；[src/app/sessions.ts:48](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/sessions.ts#L48)；`tests/bundle-patch.spec.ts` |
| SUP-7 | P1 | `write:false/edit:false/fetch:false` + `WORK_TOOLS` 白名单 + `noWait` 守卫，形成"硬裁剪（工具不存在）+ 软拦截（beforeToolCall）"双层 | 06 §3/§7 | [cordis.patch.yml:116-120,163-167](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/cordis.patch.yml#L116-L120)；[src/app/sessions.ts:61-86](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/sessions.ts#L61-L86) |
| SUP-8 | P1 | [framework-model §6] 增补"state → 唯一 writer"运行表 + `HealthBoard.claim` 式冲突即抛断言 | 03 §6，04 §10 | [docs/007-architecture.md:259-274](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L259-L274)；[src/infra/health.ts:15-33](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/infra/health.ts#L15-L33) |
| SUP-9 | P1 | 插件 API 采用"命令式请求 / 过去式事实"命名 + `UserError(code,values)` 固定拒绝码，与 hook no-throw 契约配套 | 05 §3.4/§4.2/§7 | [src/core/engine.ts:40-257](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/engine.ts#L40-L257)；[docs/007-architecture.md:62,272-274](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L62) |
| SUP-10 | P1 | 带类型的 `DomainEvent` 联合 + 单一 `emit()` 作为插件间唯一广播通道，避免插件直接互调形成隐式环 | 05 §10，04 §10 | [src/core/ports.ts:85-103](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/ports.ts#L85-L103)；[docs/007-architecture.md:105-109](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L105-L109) |
| SUP-11 | P2 | 幂等消息投递：`messageId(requestId)` + `holds/send` + 持久化 history，让 05 §10 的 await 屏障跨重启不重复 | 05 §10/§11，06 §5 | [src/app/delivery.ts:16,31-85](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/delivery.ts#L16) |
| SUP-12 | P1 | "等人工"改为结构化 `Attention` + `waitsForPerson` + `followupOwners` + `handback`，禁止从自由文本推断 | 06 §6/§8，05 §8 | [src/core/model.ts:75-88,275,349-353](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/model.ts#L75-L88)；[docs/001-domain.md:60](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L60) |
| SUP-13 | P1 | 升级/自演化：schema 只增 + 单事务迁移 + 拒绝更新版本库 + 试加载失败回滚基线 | 06 §8，08 §5/§6 | [src/app/store.ts:58-100](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/store.ts#L58-L100)；`src/app/migration.ts`；[docs/006-deployment.md:233-246](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md#L233-L246) |
| SUP-14 | P2 | 建立"拒绝概念表"与 5 级优先级（host/tool 事实 > 内置生成段 > 匹配规则 > 团队段 > 外部文本纯数据），防止概念膨胀与"提示词越权" | 06 §1/§4/§7，05 §1 | [docs/001-domain.md:45-60](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L45-L60)；[docs/004-prompts.md:65-71](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md#L65-L71) |
| SUP-15 | P2 | health 每 part 一条、3 次连续失败阈值、`quiet` 抑制重复噪音，把"少占用人类注意力"变成可验收指标 | 06 §8/§13，08 §4 | `src/infra/health.ts`；[src/app/effects.ts:147-160](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/effects.ts#L147-L160) |

### 5.3 关键状态机与不变量（供 06/08 直接引用）

- **Ticket**：`open → ended`；人在自己 Thread 的消息可 `resume` 回 open（除非人 stop）；Assignment 独立 `pending → running → ended`；只有 accept/stop/revalidation-fail 改变 Mandate。
- **Eval**：每 Thread 至多一个、串行；deadline 从 candidate delivered 起算；连续 2 次重排、第 3 次记 `unavailable`；Policy 变更丢弃并重排。
- **Effect row**：`enqueue(upsert、保留 seq、generation++) → due → running → (成功 DELETE 且 seq/generation 匹配 | Later 仅推迟 | 失败 attempts++ 退避)`；ordered kind 队头阻塞。
- **Receipt**：`pending → sent | dropped(channelGone|channelIgnored)`；`settle` 在已 withdraw 时重建已结算 receipt，保证 id 永不二次入队；FIFO 按 `(ticketId, channel.thread)`，前置失败 3 次才放行。
- **Stage**：`ticketStage()` 首匹配行胜出：`ended → delivery → answer → review → blocked/failed → queued → idle → working`。
- **核心不变量**：同 id 接受两次只建一个 Ticket（稳定 key）；core 不做 I/O、不 import 域外；Source 在 Ticket 上不存自己的东西；订阅扇出绕过门禁但不授予权威；跨源身份映射只是提示词文本；一个 state 一个 writer；一个 health 条目一个 claimer；每个 effect kind 一个 handler。

### 5.4 与论文的直接呼应

S13 的 `Effects` + `Outbox` 正是论文 §12.1 的 acquisition/emission 边界的**工程答案**：acquisition 走 `ctx.effect` 的逆（在 fiber 生命周期内可逆）；emission 走"领域事务内记账（durable intent）→ commit 后派发 → 幂等键 + receipt settle"，不承诺物理回滚而是"事实上一次 + 顺序保证"。这修正了我们 06 O-9 的默认策略建议，并把 01 §4.4 的 `replay: "never"|"safe"` 从语义钩子变成可实现的机制。


## 6 落地批次与验收

| 批次 | 建议 | 验收 |
| --- | --- | --- |
| B0（架构前） | CORE-1/2/5/6、ENG-1/2、CORE-14、SUP-1/2 | 05 §13 等价测试新增"事件 mode、单调 guard、decision union、patch 分层"四组；`--dump-config` 可输出；effects 插件落位 |
| B1（框架实现） | CORE-3/4/7/8/9/10/11/12/16、ENG-4/5/10/12/13、SUP-3/4/5/8/9/10/12/13 | 04/05/06 各节按修订清单更新；架构守护脚本纳入 CI |
| B2（UI 与体验） | ENG-7/8/9、ENG-11/15/16、CORE-13/15、SUP-6/7/15 | 07 帧快照 + 槽位生命周期测试；能力图生成；preset patch 测试 |
| B3（后续） | ENG-6/14、SUP-11/14 | 视裁决 |


## 7 对既有文档的修订清单

| 文档 | 修订点 | 对应建议 |
| --- | --- | --- |
| 03 | §3 供应链约束改记 bun 对应机制；§6.2 键双轨；§8 加架构守护；§9/§4.4 加 profile 形态 | ENG-14、CORE-15、ENG-13、CORE-14 |
| 04 | §4.2 disposer 精确身份；§6.2 isolate 断开回退；§8 patch 分层/volatile；§8.4 HMR 队列；§11 label/getEffects | CORE-2/3、ENG-1/2/5、CORE-16 |
| 05 | §3.1 五 mode；§4.2 decision union + HookChain 双原语；§8 单调 guard/并行/output；§9 权限三件套；§10 AgentHandle；§11 surface；§13 新不变量 | CORE-1/5/6/7/10/11/12、ENG-10 |
| 06 | §4 preset 内层 entry；§6/§7 权限三件套与 presets；§9 execution world；新增插件市场节 | ENG-3/10/11/15/16 |
| 07 | §4 ConversationNode；§5 槽位声明合并/inject；§10 boot graph | ENG-7/8/9 |
| 08 | §4 新增验收项；B0-B3 批次 | 全部 |
| 09 | 新增 S12/S13 来源、双源验证、矛盾（如 symbol vs 字符串 key、backup vs 无 backup） | 全部 |


## 8 交叉引用与验证

| 本文结论 | 上游来源 | 下游验证 |
| --- | --- | --- |
| 五大发现 | S12 [docs/architecture.md:9-11](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#L9-L11) | 各建议的验收测试 |
| 47 条优化建议 | S12/S13 源码路径（逐条标注） | §6 批次验收 |
| 与论文一致处 | [01](./cordis-paper-theory.md)、[09](../architecture/fact-registry.md) | [03 P1-P10](../architecture/framework-model.md#2-从论文推导出的十条工程原则) |
| 具体修订 | [7 修订清单](#7-对既有文档的修订清单) | 各文档更新后的交叉引用表 |

**返回索引**：[00](../README.md)


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
