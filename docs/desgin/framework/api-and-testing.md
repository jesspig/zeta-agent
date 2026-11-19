# 对外 API、测试与取舍

> **文档定位**：对外 API、测试与取舍（从 `04-开发框架层设计.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [11 测试与调试 API](#11-测试与调试-api)
- [12 与 chord / Cordis 的对应关系](#12-与-chord-cordis-的对应关系)
- [13 风险与开放问题](#13-风险与开放问题)
- [14 交叉引用与验证](#14-交叉引用与验证)

## 11 测试与调试 API

`@zeta-agent/framework/testing` 提供：

- `createTestContext()`：无 HMR、无 IO 的 ctx，带 `get/set/use/effect` 全部语义。
- `assertQuiescent(ctx)`：等待所有 fiber 到 settled 状态（INACTIVE/ACTIVE/FAILED）。
- `assertNoResidue(ctx, baseline)`：断言所有 effect 的逆都调用过一次、`@@store` 回到基线（对应 Cor 69）。
- `replayConfig(ctx, entries, orders[])`：用多种加载顺序重放，断言最终观察状态一致（对应 Thm 80）。
- `observeDispose(ctx)`：记录逆调用序列，验证 LIFO 顺序。
- `faultInject(effectStep)`：让某个 effect 步骤抛错，验证 FAILED 路径与无残留。

这些 API 是 [framework-model/engineering §12 验收](../architecture/engineering.md#12-验收标准) 的落地手段。


## 12 与 chord / Cordis 的对应关系

| 维度 | chord 现状（[02](../research/pi-baseline.md)） | Cordis 论文（[01](../research/cordis-paper-theory.md)） | zeta 取舍 |
| --- | --- | --- | --- |
| 插件单元 | facet（setup 只声明） | component `(d,p,e)` | 合并：`Component.inject/provide/apply`，apply 只产出 effect |
| 加载/重载 | `host.load/reload` + closure rule + 旧工作排空 | L-Begin…L-Unload + guard | 用 fiber 状态机统一；保留 closure 思想 |
| 模块缓存 | 无 module map / require cache，digest 复用 | HMR 事务式重载 | 采用"构建产物 + digest + 全新求值"，不依赖 Bun 缓存驱逐 |
| 依赖 | 契约 + 注册表（两种） | coeffect key + target/committed view | 统一为 `CoeffectKey`，注册表是特殊 key |
| 跨进程 | link / remote / hostKind / rollout | service broker（§12.2） | 最小版单进程；接口留 link 位置 |
| 数据 | document / store / delta（非 CRDT） | `Σ` 涵盖所有共享可变状态 | 文档/存储作为可选子路径 |
| 权限 | principal / 注册表 | capability via inject + intercept | `ctx[key]` 门禁 + 拦截元数据 |


## 13 风险与开放问题

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| async generator 的取消语义 | `iter.return()` 是否触发已 yield 逆的回收？ | 显式 `armed` 门控 + `execute` 统一 dispose，不依赖 generator 自动清理 |
| Bun 模块缓存 | ESM/Bun 的缓存驱逐无稳定公开 API | 构建产物独立 URL + vm/digest；实测验证（O-4） |
| digest 复用 vs fiber 身份 | digest 相同复用 facet 对象，但 fiber 可能需要重启 | 区分"模块实例"与"fiber 实例"：前者按 digest 复用，后者按 entry id 管理 |
| 注册表 compose 的副作用 | 贡献方可能在 compose 里做副作用 | 规定 compose 同步纯函数，测试断言 |
| 过度设计对象运行时 | 一次性实现全部 chord 能力 | §9 明确为可选子路径，最小内核不含 |

**开放问题**：
- O-4：Bun 下能否稳定驱逐 ESM 模块缓存？需实测；若不能，HMR 必须走 vm/独立 URL（建议）。
- O-5：`FAILED` 后的自动重试策略需要配置（立即/退避/仅手动）？建议仅手动 revision，避免无限循环（论文 §4.4）。
- O-6：guard 等待依赖方的方法需要超时吗？建议设 `drainTimeout`（chord 有 `reloadDrainTimeout` 5s），超时后记录错误但继续撤回。


## 14 交叉引用与验证

| 本文设计 | 上游依据 | 下游验证 |
| --- | --- | --- |
| `ctx.effect` 唯一入口 | [cordis-paper §10.1](../research/cordis-paper-theory.md) | [08](../delivery/roadmap.md#4-验收标准) 可逆性测试 |
| LIFO 累积器 | [cordis-paper §4.2](../research/cordis-paper-theory.md) | `observeDispose` 逆序断言 |
| 键命名空间 | [cordis-paper §12.6](../research/cordis-paper-theory.md)、[framework-model/engineering §6.2](../architecture/framework-model.md) | 同名键冲突测试 |
| target/committed view | [cordis-paper §10.3](../research/cordis-paper-theory.md) | 同值替换触发 reload 测试 |
| guard / Thm 70 | [cordis-paper §9](../research/cordis-paper-system.md#9-元理论五条承重保证) | teardown 读依赖测试 |
| entry 对账 | [cordis-paper §10.5](../research/cordis-paper-theory.md) | 配置 revision 测试 |
| HMR 三阶段 | [cordis-paper-system §10.6](../research/cordis-paper-system.md#10-实现cordis-三层架构与十一个算法)、[02 chord 报告](../research/pi-baseline.md) | 故障注入测试 |
| 注册表 contribution | [02 chord 报告 §3.5](../research/pi-baseline.md) | 冲突报告测试 |
| 对象运行时 | [02 chord 报告 §4-5](../research/pi-baseline.md) | 文档事务回放测试 |
| 供上层使用 | [05](../agent-framework/overview.md)、[06](../agent/plugin-system.md)、[07](../agent/tui.md) | 各层集成测试 |

**返回索引**：[00 索引与交叉验证](../README.md)


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
