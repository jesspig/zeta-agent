# 框架组件：loader、HMR、store 与注册表

> **文档定位**：框架组件：loader、HMR、store 与注册表（从 `04-开发框架层设计.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [8 组件加载器与 HMR](#8-组件加载器与-hmr)
- [9 对象运行时与跨进程边界（可选子路径）](#9-对象运行时与跨进程边界可选子路径)
- [10 注册表与 contribution](#10-注册表与-contribution)

## 8 组件加载器与 HMR

### 8.1 Entry（论文定义 81）

> **字段模型已按 cordis 官方源码校正（[cordis-source-verification §3 #10](../research/cordis-source-verification.md)）**：官方 Entry 无 `url`（用 `name` 模块说明符）、无 `children`（group 的 `config` 即子 entry 列表，id 用 `:` 分层）、`isolate` 是按服务的 `Dict<true|string>`、`disabled` 支持 `JsExpr`。早期草案的 `url`/`children` 模型已废弃，roadmap 阶段 1 以本模型为准。

```ts
export interface Entry {
  readonly id: string;                            // 对账键，稳定；group 子项用 ':' 分层
  readonly name: string;                          // 模块说明符（替代旧草案的 url）
  readonly config?: unknown;                      // 绑定进 apply 的载荷；group 的 config 即子 entry 列表
  readonly isolate?: Record<string, true | string>; // 按服务名：true=局部 realm，string=全局 realm label
  readonly intercept?: Record<string, unknown>;   // 按服务的拦截元数据
  readonly inject?: Inject;                       // 依赖声明（数组或对象）
  readonly disabled?: boolean | { __jsExpr: string }; // administratively off / JS 表达式
  readonly group?: boolean | null;                // true=group，config 为子 entry 列表
  readonly volatile?: boolean;                    // volatile 变更走 reflect.notify 不 remount
}
```

entry ↔ fiber 双向绑定：字段变化 → 调整 fiber；组件自行改配置/禁用自己 → 回写 entry（官方 `internal/plugin` 监听有 7-case 判别，排除 loader 主动移除/父卸载/tree 销毁；chord 的插件也能自我修改应用，[02 chord 报告 §0](../research/pi-baseline.md)）。

> **P0 修订（[10 CORE-14 / ENG-1/2](../research/dsh-optimizations.md#4-工程配置与-ui-优化eng)）**：entry 不再由应用手写数组，而是**有序配置层派生**：`profile bundles → profile patch → home patch → --patch overlay`，作用于**空 entry 列表**。patch 引擎按 `id` **整块替换 config（非深合并）**或 `insert` 新行；`name` 不一致则跳过并告警；保留 `EntryOwner` 来源归因以支持 `--dump-config`。row 顺序不承载加载语义（激活由 service 可用性驱动）。字段增加 `volatile?: boolean`：volatile 变更走 `reflect.notify` 直接更新运行中的 fiber（不 remount），material 才走完整生命周期。preset 的 `config.plugins` 也是 entry list，同一 patch 机制递归应用。CLI 提供 `--profile` / `--dump-config`。

### 8.2 逐字段最小对账

| 字段变化 | 动作 |
| --- | --- |
| `id` / `name` | 重建 fiber（retire → 等去活 → remove → insert） |
| `isolate` | realm 重分配（见下，按服务名字典） |
| `intercept` | 就地更新（读时 consult，不 reload） |
| `config` | group 内按 id keyed diff；其余交给组件 diff，仅材料变化 reload |
| `disabled` | true → unload；false → 重新 insert |

`group: true` 的 entry 把 `config` 作为子 entry 列表，按 `id` 做 keyed diff + `Promise.all`，递归复用同一 dispatch；include 加载外部 JSON/YAML 并嫁接子树——都是普通组件，用 `ctx.use` 实现，不进内核。官方用 `EntryTree.sep=':'` 做分层 id，冲突时 file wins + 逐条上报（include journal 三方 reconcile）。

### 8.3 realm 重分配与 delimiters

问题：一个 realm symbol 可能被多个 fiber 共享，只有其中一个是 provider，如何只搬走"属于本 entry"的绑定？论文算法 7 的答案是 **delimiter**：每个键一个符号 `δk`，写在 context 上并被后代继承；entry 与 provider 的 `δk` 相同当且仅当两者在同一 isolate 作用域派生。重分配时：

1. 对变化的键 `k`，在 entry context 写新 `δk`（fresh tag）；
2. 记录 diff `(s1, s2, d1, d2)`：旧 realm、新 realm、entry tag、provider tag；
3. reload entry fiber；
4. 仅当 `d1 === d2` 且 `s1` 有绑定而 `s2` 没有时，把绑定从 `s1` 搬到 `s2`；
5. 用自定义 `affected` 测试（realm ∈ {s1,s2} 且 delimiter 分离）通知依赖方。

### 8.4 HMR 三阶段（借鉴 chord + 论文）

chord 的插件机制已经非常成熟：发现→esbuild 冷构建→`vm.Script` 求值（**无 module map / require cache**）→digest 驱动最小重求值→按 host 滚动发布→closure rule + 旧工作排空（[02 chord 报告 §3.4](../research/pi-baseline.md)）。论文的 HMR 三阶段（[cordis-paper-system §10.6](../research/cordis-paper-system.md#10-实现cordis-三层架构与十一个算法)）与之互补。我们的设计取两者之长：

**阶段 1：发现与构建（运行时核心能力，非开发期工具）**
- 只列目录、读 `package.json`（不解析源码），字段 `zeta.plugins`（glob + `!` 排除，仿 chord/pi）。
- 每个 facet kind（如 `agent`、`tui`、`server`）一个文件，默认导出 component/facet。
- 用 esbuild 把组件打成**单文件 wrapper**（CommonJS/ESM），host 包与外部依赖保持 external；失败作为返回值 `BuiltFacet {kind:"failed", errors}`，不抛异常。
- 产物带 `digest`（输入文件哈希）；digest 相同则复用已求值对象（chord 的 `LoadedFacets.reload` 做法），插件对象不重启。

**阶段 2：分类与过期检测**
- stashed（内容已变文件）与 externals（不可热替换）作种子，取不动点：import 了 accepted 模块 → accepted；所有 import 都 declined → declined；循环未决 → declined（论文算法 8）。
- 对每个 entry 求依赖树（declined 为边界），与 accepted 相交即为 stale（论文算法 9）。

**阶段 3：按 unit 部分提交的重载（已按 cordis 官方源码修正）**

> **来源校正（[cordis 源码验证 §4.2](../research/cordis-source-verification.md#42-hmr-的真实语义最重要纠正)）**：官方 HMR 与我们早期草案有三处根本不同——① 组件替换是 `ctx.registry.replace()` **原地复用同一 fiber**（`_revision++`），不是 dispose + 换 fiber；② 事务是**按共享驱逐模块的连通单元部分提交**，不是"绝不半重载"；③ Stage 3 apply 失败**留 FAILED 等下次文件变更重试**，不回滚。

- `backup = caches.evict(evicted)` 只备份缓存（ESM loadCache + CJS require.cache），**只改缓存，不动 fiber**；
- 新模块 import + 校验 exports 成功 → `ctx.registry.replace(component, replacement)` 原地替换、复用 fiber（保留 parent/config、`_revision++`）；
- 按连通单元分组：`Result { settled, aborted, skipped }`。失败/跳过的单元（SkipReason: host-module | native-addon | ambiguous-import | ambiguous-export）执行 `backup.restore(restored)` 只恢复该单元的缓存与 resolutions，其他单元正常提交；
- apply 失败的 fiber 留 `FAILED`，下次文件变更时重试（resume 语义）；事务用单队列 + AsyncLocalStorage 防嵌套。

**Bun 偏离（显式标注）**：官方强依赖 Node ≥22 内部 API（`--expose-internals` 的 ESM loader + patch `Module._load`/manifest/ResolveCache），Bun 无这些能力。我们保留"构建产物独立 URL + digest + 模块驱逐"的自研路径，**这是相对官方的显式偏离，不是官方方案**。backup 语义（按 unit 部分恢复）仍可借鉴。

**与 chord 的差异**：chord 按 host kind 逐 host 滚动并保留"旧工作跑旧代码"；我们的最小版只在单进程内换组件，跨进程/滚动发布留到 [§9](#9-对象运行时与跨进程边界可选子路径) 的升级路径。


## 9 对象运行时与跨进程边界（可选子路径）

chord 把"跨进程对象"做成一等公民（[02 chord 报告 §4-5](../research/pi-baseline.md)）。我们在 `@zeta-agent/framework/objects` 提供**兼容思想的最小实现**，不作为内核依赖。

**实现状态（2026-11-24）**：contract / document / store（内存后端）/ link（memoryLinkPair）/ delta 已实现并通过语义与类型测试（`packages/framework/src/objects/objects.spec.ts`）；host/facet/Reference、IPC/WS、SQLite、group commit、outbox、jobs/derive/rollout 按 YAGNI 未实现。下表“zeta 草案”列中这些项仍为设计预留，不代表已实现：

| chord 概念 | zeta 草案 | 最小版取舍 |
| --- | --- | --- |
| `local/remote` contract + version + fingerprint | `defineContract({name, version, params, members, accepts})` | 保留版本与 `accepts` 映射 |
| `createHost`, facet, `host.serve/get/reload` | `createHost`, `defineFacet`, `host.load/get/reload` | 复用 §7 fiber 状态机 |
| reference（live、release 保持存活） | `Reference<T>` + `release()` | 保留引用计数 |
| document `defineState` + `Tx` + watch | `defineDocument` + `tx.draft/put/...` | 第一版只做 JSON 文档与事务 |
| store（提交队列、group commit、outbox） | `openStore` + `defineTable` | 提供内存后端，SQLite 后端可选 |
| delta tracker（精确 op 批、顺序应用） | `track/prepare/adopt/applyImmutable` | 第一版只做进程内 |
| link（memory/ipc/ws）+ codec | `Link` + `memoryLinkPair` | IPC/WS 作为可选子路径 |
| registry contribution + compose | 见 §10 | 内核必需 |
| jobs / derive / native watch | 延后 | 需要时再加（YAGNI） |

**关键决策**：**不是 CRDT**——单一权威 + 有序副本 + 精确 delta 批（与 chord 一致，[02 chord 报告 §4](../research/pi-baseline.md)）。冲突通过"权威接受/拒绝 + 版本指纹 + 声明依赖 park"处理。这让 §7 的 fiber 生命周期覆用到对象重载：换插件代码时，对象要么 restarted / retried / ended / parked，旧调用跑旧代码、新调用等新代码。

> 升级路径：若后续需要 worker/web/tui 跨进程，直接引入 chord 风格的 `host.route(hostKind)` + `rollout` 机制；内核接口已通过 link 抽象留出位置。


## 10 注册表与 contribution

借鉴 chord：插件间**只通过契约与注册表交流**（[02 chord 报告 §3.5](../research/pi-baseline.md)）。

```ts
export function defineRegistry<C, V>(name: string, opts: { version: number; compose: (table: Table<C,V>, report) => V }): Registry<C,V>;

interface FacetHost {
  serve<C>(key: CoeffectKey<C>, provider: Provider<C>): void; // 唯一 provider
  references<C>(key: CoeffectKey<C>): Watchable<View<C>>;     // 只读活引用
}
interface FacetSelf {
  contribute<C>(registry: Registry<C, unknown>, value: Contribution<C>): void;
}
```

规则：

- 每个注册表只有一个 provider，由 `host.serve` 声明；贡献方 `self.contribute` 每注册表至多一个贡献。
- `compose(table, report)` 必须**纯同步、总有回退值**；表按插件名排序（与加载顺序无关）；冲突用 `report` 上报。
- 贡献可以是普通值或 watchable；watchable 变化时重新 compose。
- 使用点必须防御性捕获贡献代码异常（chord 设计规则），否则一个坏插件拖垮宿主。
- 版本通过 `accepts[version].value` 映射；版本不匹配 → fiber `FAILED { waiting }`，不喂错数据。

**与 fiber 的关系**：注册表本身就是一种 coeffect key（`@zeta-agent/registry:<name>`），provider 是一个 fiber，contribution 是 `ctx.set`；所以注册表机制**没有第二套生命周期**——完全落在 §4/§7。这正是"万物皆插件"的闭环。


## UML 视图

### 图 1：配置分层与加载组件（组件图）

```mermaid
flowchart LR
    subgraph CFG["配置源"]
        B["bundle patch (base)"]
        PP["profile patch"]
        HP["home patch"]
        OP["--patch overlay"]
    end
    subgraph COMP["loader 组件内部"]
        AP["applyPatches<br/>按 id 整块替换 / insert"]
        OWN["EntryOwner 来源归因"]
        REC["reconciliation 逐字段对账"]
    end
    subgraph RT["运行时组件"]
        HMR["hmr: 单队列 + readiness"]
        FIB["cordis: fiber 状态机"]
        ST["store: document / tx / watch"]
    end
    B --> AP
    PP --> AP
    HP --> AP
    OP --> AP
    AP --> OWN --> REC --> FIB
    HMR --> AP
    FIB --> ST
```

### 图 2：Entry 与 Fiber 的对象关系（对象图）

```mermaid
classDiagram
    class Entry {
      +id: string
      +name: string
      +isolate: Record~string, true|string~
      +intercept: Record~string, unknown~
      +config: unknown
      +group: boolean
      +disabled: boolean|JsExpr
    }
    class Fiber {
      +uid: FiberId
      +state: LifecycleState
      +target: View
      +committed: View
    }
    class View {
      +Map~CoeffectKey, Impl~
    }
    class Impl {
      +uid: FiberId
      +value: unknown
      +check(): boolean
      +dependents: Set~FiberId~
      +isolate: symbol
    }
    class StoreSlot {
      +realm: symbol
      +value: unknown
    }
    Entry "1" --> "1" Fiber : reconcile
    Fiber --> View : target / committed
    Fiber --> StoreSlot : provides (realm)
```

### 图 3：HMR 事务式重载（时序图）

```mermaid
sequenceDiagram
    participant W as watcher
    participant Q as runExclusive 队列（防嵌套）
    participant L as loader
    participant C as caches（ESM/CJS）
    participant R as registry
    participant F as fiber（复用）
    W->>Q: 标记 dirty（stashed/retained）
    Q->>Q: 等待 appReady + debounce 100ms
    Q->>L: _analyze 分类 accepted/declined + 连通单元
    L->>C: backup = evict(evicted)（只改缓存）
    alt 导入/exports 校验失败
        C->>C: backup.restore(该单元模块)
        L-->>Q: skipped/aborted（其他单元照常提交）
    else 成功
        L->>R: registry.replace(component, replacement)
        R->>F: 原地替换（保留 parent/config，_revision++）
        F->>F: await 本单元 fibers
        alt apply 失败
            F->>F: 留 FAILED（下次变更重试，不回滚）
        else 成功
            F-->>Q: settled
        end
    end
```

## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
