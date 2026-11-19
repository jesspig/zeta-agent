# Cordis 官方源码对照验证

> 文档编号：研究篇 S19　|　主题：用 Cordis 官方 TypeScript 实现逐行对照验证我们的复刻设计
> 一手来源：[cordiverse/cordis](https://github.com/cordiverse/cordis)（`packages/core` 版本 `4.0.0-rc.13`，API 未稳定）。此前我们的蓝本是 arXiv:2608.25512v1 论文 + deepseek-harness 的 vendored 变体（v4 alpha），本次第一次拿到官方源码。
> **重要**：我们是**复刻论文**，不引入该包。本文件只做对照验证，不是依赖声明。
> 所属索引：[research/README.md](./README.md)　|　修正落点：[core-semantics.md](../framework/core-semantics.md)、[components.md](../framework/components.md)

## 目录

- [1 结论速览](#1-结论速览)
- [2 我们设计中正确的部分](#2-我们设计中正确的部分)
- [3 我们设计中错误或过简的部分](#3-我们设计中错误或过简的部分)
- [4 关键纠正详解](#4-关键纠正详解)
- [5 对七个缺口的官方参考](#5-对七个缺口的官方参考)
- [6 落地决议](#6-落地决议)
- [7 交叉引用与验证](#7-交叉引用与验证)

---

## 1 结论速览

官方源码验证了我们的**核心语义骨架是对的**（effect 唯一入口、LIFO、依赖重激活、guard、隔离 realm、patch 对账），但纠正了 **13 处错误或过简**，其中 4 处是根本性的：

1. **`@mode` 装饰器官方不存在**——静态约束靠 `interface Events` 声明合并；
2. **HMR 语义完全不同**——`registry.replace()` 原地复用 fiber + 按 unit 部分提交，不是换 fiber + 全局回滚；
3. **撤销顺序**——effect 内严格 LIFO，但 fiber 卸载多 effect 是"逆序启动、并发执行"；
4. **Bun vs Node**——官方 HMR 强依赖 Node ≥22 内部 API（`--expose-internals`），我们在 Bun 上的路径是自研偏离，必须显式标注。

另外两个事实修正：**不存在 `packages/events` 包**（五模式事件在 core 内）；官方**没有 digest、没有 esbuild 冷构建**（那是 deepseek 变体/chord 的方案）。

## 2 我们设计中正确的部分

| 我们的设计 | 官方证据 |
| --- | --- |
| `ctx.effect` 唯一变更入口 | `ctx.on/once`、`provide/accessor/mixin`、timer、fs.mount/watch、http、路由、include journal 全部走 `ctx.fiber.effect()` |
| 逆在施加点返回、一次性、effect 内 LIFO | `dispose` 用 `disposables.splice(0).reverse()`；`runner.epoch=false` 保证一次性 |
| async generator + guard 中断 + finally | `_execute()` 的 `while (runner.epoch === oldEpoch)`，中止时 `iter.return?.()` |
| 子 fiber 随父撤销 | `Fiber` 构造函数 `parent.fiber.effect(...)` |
| 依赖变化重激活 + 惯性锁 + FAILED 不重试 | `Impl.uid` 拼进 epoch、`inertia` 并发锁、`if (this._error) return` |
| provider 撤回等待消费者去活 | `Impl.dependents` + `_release`：`while ([...provisions].some(i => i.dependents.size)) await ...` |
| 沿 fiber 链解析、未声明拒绝 | `locate()` + Proxy get trap |
| isolate/intercept 派生 context 无需撤销 | `Context.extend/isolate/intercept` 用原型链，逆=丢弃派生对象 |
| 配置 patch 按 id、整块替换 config、name 不匹配告警、归因 | `include/src/patch.ts` |
| group 是普通组件、children 按 id keyed diff | `loader/src/config/group.ts` |
| realm 重分配 delimiter 算法 | `loader/src/config/isolate.ts` 与我们 §8.3 同构 |
| core 零生态依赖 | `core/package.json` 仅 `cosmokit` + `@standard-schema/spec` |

## 3 我们设计中错误或过简的部分

| # | 问题 | 官方事实 | 我们的修正 |
| --- | --- | --- | --- |
| 1 | `@mode` 静态校验 | 不存在；靠 `interface Events` 声明合并 + `@ts-expect-error` | 已改：声明合并方案，`@mode` 降为变体参考 |
| 2 | Effect 类型只支持 AsyncGenerator/Disposer | 4 种：同步 Disposer、同步 iterable、Promise&lt;Disposer&gt;、异步 iterable | 需扩 `Effect` union 类型 |
| 3 | FiberState 5 态 | 6 态：`PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING` | 需把 INACTIVE 细分为 PENDING + DISPOSED |
| 4 | 全局严格串行 LIFO | effect 内严格串行；fiber 卸载多 effect **逆序启动、并发执行**（`Promise.all(this._disposables.clear().reverse().map(...))`） | 需区分两层语义，依赖顺序交给 iterator/service |
| 5 | `CoeffectKey{namespace,name,symbol,...}` | 字符串服务名 + `Inject` 数组/对象 + 声明合并 | **保留我们的形式化模型，但标注为自研增强** |
| 6 | `View = Map<key, FiberId>` | `committed: Dict<Impl>`，Impl 含 `value/check/isolate/dependents` | 需补 check 动态能力判定与 dependents |
| 7 | `ctx.use()` 返回 Fiber | 官方返回 `Fiber & PromiseLike<Fiber>`，另有 `await()/update()/restart()/getEffects()` | 补可等待与诊断入口 |
| 8 | 组件只有 apply | 官方有 `[Service.init]`/`[Service.invoke]` generator、`@Inject` 装饰器、StandardSchema 校验 | 补 schema 校验与生命周期分层 |
| 9 | HMR 换 fiber + 全局回滚 | `registry.replace()` 原地复用 fiber；按 unit 部分提交；无 digest/esbuild；Stage3 失败留 FAILED 下次重试 | **见 §4.2 详解** |
| 10 | Entry 有 `url/children` | 无 url（用 `name` 模块说明符），无 children（group 的 config 即子列表，id 用 `:` 分层），isolate 是按服务的 `Dict<true\|string>`，disabled 支持 `JsExpr` | 修正 Entry 字段模型 |
| 11 | 事件 parallel 简单 await | `Promise.allSettled` + `AggregateError` | 加错误聚合 |
| 12 | 无 VFS / env 分层抽象 | `fs/core` 的 `Fs extends Service`，mount scheme 最长匹配；env 四层优先级 + 可撤销 populate | 补 VFS 与 env 组件 |
| 13 | entry↔fiber 双向绑定一句话 | self-dispose 回写有 7-case 判别（排除 loader 主动移除/父卸载/tree 销毁等） | 细化判别逻辑 |

## 4 关键纠正详解

### 4.1 事件派发的真实静态约束

官方 `packages/core/src/events.ts`：`DispatchMode = 'emit'|'parallel'|'serial'|'bail'|'waterfall'` 正确，但**没有 `@mode` 字段**。类型安全靠：
```ts
declare module './context.ts' {
  interface Context { emit<K extends keyof Events>(name: K, ...args): void; ... }
}
```
测试 `events.types.ts` 用 `@ts-expect-error` 断言非法派发编译失败。`on()` 的 options 只有 `{prepend?, global?}`。`waterfall` 的终止函数由调用方作为最后一个参数传入，重复 `next()` 抛 `next() called multiple times`。另有 11 个内部事件（`internal/plugin/replace/status/service/update/commit/config/get/set/listener/dispatch`），其中 `internal/get`/`internal/set` 是依赖访问拦截点（安全门禁天然挂钩处）。

### 4.2 HMR 的真实语义（最重要纠正）

| 阶段 | 官方实现 | 我们原设计 |
| --- | --- | --- |
| Stage 1 异步 | `backup = caches.evict(evicted)` → import 新模块 → 校验 exports；**只改缓存，不动 fiber**；失败从 backup 恢复 | backup 概念一致 ✅ |
| Stage 2 同步 | `ctx.registry.replace(component, replacement)` **原地替换组件、复用同一 fiber**，`_revision++` | ❌ 我们是 dispose + 换 fiber |
| Stage 3 | `await Promise.all(fibers.map(f => f.await()))`，**无回滚**：apply 失败留 FAILED，下次文件变更重试 | ❌ 我们"整体提交或回滚" |

**backup 去留结论：必须保留，但语义是"按 unit 部分恢复"**：
```ts
const backup = caches.evict(evicted)
const backup.restore(restored)  // restored = aborted ∪ skipped 单元的模块集合
```
`Result { settled, aborted, skipped }`，`SkipReason = host-module | native-addon | ambiguous-import | ambiguous-export`（需重启）。事务用 `_queue` + `AsyncLocalStorage` 防嵌套。

**Bun 偏离**：官方依赖 Node 内部 ESM loader（`ModuleLoader.fromInternal()`，`--expose-internals`）与 patch `Module._load`/manifest/ResolveCache。Bun 无这些 API，我们的"构建产物独立 URL + digest + 模块驱逐"是**显式偏离**，保留并在文档标注，不假装是官方方案。

### 4.3 撤销的两层语义

- **单个 effect 内**：严格 LIFO 串行（`dispose.spec.ts` 断言 `[3,2,1]`）；
- **fiber 卸载多个顶层 effect**：`Promise.all(this._disposables.clear().reverse().map(...))`——逆序启动、并发执行，一个 teardown 不等待另一个。有依赖顺序的清理交给 effect iterator 或 service（`Impl.dependents`）。

### 4.4 可观测性（官方有，但也没有 tracing）

官方 `packages/core/src/logger.ts`：`Message{sn,ts,name,type,level,args,fiber: WeakRef<Fiber>}`——**每条日志关联组件 fiber**；多 Exporter、环形 buffer（1000）、`maxLength` 逐行截断；`getEffects(): EffectMeta[]` effect 元树；`internal/status` 事件；长栈（`composeError`）+ 代码帧（`hmr/src/error.ts`）。**但官方也没有 span/OTel**——分布式 tracing 仍需我们补（见 opencode / coze-studio 参考）。

## 5 对七个缺口的官方参考

| 缺口 | cordis 官方能提供的 | 来源 |
| --- | --- | --- |
| 2 可观测性 | per-fiber WeakRef 日志、Exporter、ring buffer、EffectMeta 树、internal/status、长栈与代码帧 | [logger.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/logger.ts)、[utils.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/utils.ts) |
| 3 多租户 | isolate/intercept/extend、locate 按 def-site/use-site 解析、事件 `Context.filter` 按会话过滤 hook、LocalRealm/accessGlobal | [context.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)、[isolate.ts](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/config/isolate.ts) |
| 4 安全 | 未声明访问抛错、internal/get/set 拦截、assertActive、intercept 能力调整、Host ACL、可撤销 env.populate、文件权限不降级备份 | [reflect.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/reflect.ts)、[acl](https://github.com/cordiverse/cordis/blob/main/packages/server/acl/src/index.ts) |
| 5 评估测试 | 各包完整 vitest 测试，测试即规格；类型测试 `@ts-expect-error` | [fiber.spec.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/tests/fiber.spec.ts)、[events.types.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/tests/events.types.ts) |
| 6 性能 | 日志 ring buffer + 长度上限 + 延迟栈捕获、HMR debounce 100ms + 单队列、allSettled 不短路、原子 rename + 锁退避 | [hmr/index.ts](https://github.com/cordiverse/cordis/blob/main/packages/hmr/src/index.ts)、[logger.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/logger.ts) |
| 7 部署 | daemon fork/IPC/heartbeat/autoRestart、脚手架、server 端口扫描、事务式包安装 | [daemon.ts](https://github.com/cordiverse/cordis/blob/main/packages/cli-cordis/src/worker/daemon.ts)、[package-manager](https://github.com/cordiverse/cordis/blob/main/packages/package-manager/src/index.ts) |
| 8 错误恢复 | ModuleBackup.restore + unit aborted/skipped/committed、FAILED 只由 update 恢复、composeError 长栈、AggregateError、安装失败 backup+recover、配置三方 file-wins | [hmr/index.ts](https://github.com/cordiverse/cordis/blob/main/packages/hmr/src/index.ts)、[journal.ts](https://github.com/cordiverse/cordis/blob/main/packages/include/src/journal.ts) |

## 6 落地决议

1. **已修正（正文已落地）**：`@mode` 措辞（声明合并替代）；HMR 按 unit 部分提交语义（components.md §8.4）；Effect 4 形态（core-semantics §4.1）；FiberState 6 态（core-semantics §3.2/§7）；View=Impl（core-semantics §3.2）；撤销两层语义（core-semantics §4.1/§5）；Entry 字段模型（components.md §8.1，name/按服务 isolate/group.config）；parallel 错误聚合（runtime.md §3.1 校正注记）。
2. **阶段 5+ 待办**：VFS（`fs/core` 的 mount scheme 最长匹配）与 env 四层优先级 + 可撤销 populate 尚未作为组件纳入 framework 清单；self-dispose 7-case 判别尚未细化到实现级——这些是增强项，不阻断阶段 0-1。
3. **保留偏离**：Bun 模块驱逐路径（Node 内部 API 不可用）、形式化 `CoeffectKey` 模型（比官方更严谨，标注自研增强）。
4. **采纳**：官方 logger/EffectMeta 已并入 [observability.md](../framework/observability.md)；VFS/env/7-case 见第 2 条待办。

## 7 交叉引用与验证

| 本文结论 | 上游来源 | 下游验证 |
| --- | --- | --- |
| 五模式正确、@mode 不存在 | cordis `events.ts` | [runtime.md](../agent-framework/runtime.md) 已修正 |
| HMR 部分提交语义 | cordis `hmr/index.ts` | [components.md](../framework/components.md) §8.4 已落地 |
| 撤销两层语义 | cordis `fiber.ts` + dispose.spec.ts | [core-semantics.md](../framework/core-semantics.md) §4.1/§5 已落地 |
| 可观测性官方能力 | cordis `logger.ts` | [observability.md](../framework/observability.md) 已落地 |
| 七个缺口参考 | 见 §5 逐条链接 | architecture/fact-registry.md |

**总索引**：[README.md](../README.md)　|　**事实登记**：[fact-registry.md](../architecture/fact-registry.md)
