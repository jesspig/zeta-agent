# Agent 框架总览

> **文档定位**：Agent 框架总览（从 `05-Agent开发框架层设计.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [1 定位：保留极简，替换扩展方式](#1-定位保留极简替换扩展方式)
- [2 包边界与依赖](#2-包边界与依赖)

## 1 定位：保留极简，替换扩展方式

pi-agent-core 的价值在于**不变量与顺序控制**：6 个源文件、10 个事件、一条工具流水线、一组 hook 字段（[pi-baseline §4](../research/pi-baseline.md#4-earendil-workspi-agent-core极简-agent-运行时)）。我们要做的是：

- **原样保留**：`runLoop` 状态机的轮次边界、事件屏障、工具流水线阶段顺序、`terminate` 规则、错误归一化、system 消息作为单一事实源。
- **替换**：把"可写字段 + previous-hook monkey-patch"升级为**有序插件管线**（论文意义上的 component/fiber 插件），使 [pi-baseline §9](../research/pi-baseline.md#9-重构必须保留的不变量清单) 的每条不变量都有插件版等价测试。
- **不引入**：内置工具、provider 目录、持久化、会话抽象——这些在 [06](../agent/plugin-system.md) 以插件实现。

> 核心判断：**重构的风险不是功能缺失，而是顺序语义漂移**。因此 §13 的等价测试先于实现。

> **框架定位（概念修正）**：`@zeta-agent/agent-framework` 是由内部组件（loop/turn/inbox、tools/decision/guard、session/stream/interrupt）**拼装成的 Agent 框架**，对上层应用只暴露 facade API（`createAgent()` / `Agent` / `AgentPlugin` / `AgentRuntime`，见 `src/index.ts`）。应用（CLI/TUI/未来形态）调用 facade，**不 import 内部组件**。本框架通过 `@zeta-agent/framework` 的 facade 使用通用能力，也不深入其内核。详见 [framework-model/engineering §4](../architecture/framework-model.md#4-两个框架与应用形态组件拼装模型)。


## 2 包边界与依赖

**决议（解决 [03 O-1](../architecture/engineering.md#11-风险回滚与开放问题)）**：`@zeta-agent/agent-framework` 只依赖 `@zeta-agent/framework` 的 **facade**（`src/index.ts` 的导出），**不 import 其 `src/components/**` 内部组件**；运行时通过构造参数注入 facade 句柄（`CoreContextLike`）：

```ts
export interface AgentCoreOptions {
  readonly ctx?: CoreContextLike;                 // 运行时可选；缺省用最小内部实现
  readonly streamFn: StreamFn;                    // 必需（保持 provider 无关）
  readonly identity?: ClientIdentity;
  readonly initialState?: AgentInitialState;
  readonly plugins?: readonly AgentPlugin[];
}
```

理由：

1. 与 pi-agent-core 完全一致的解耦（只依赖 `pi-ai` + `pi-schema`），便于单独发布与测试；
2. 需要 fiber 语义时（如工具插件热重载），由上层把 `ctx` 注入，插件通过 `AgentPluginApi` 使用；
3. 类型导入保证 `AgentEvent` 等可与 core 的 `CoeffectKey` 互操作，但不产生运行时耦合。

`CoreContextLike` 最小接口：`effect()`, `use()`, `get()`, `set()`, `onDispose()`。不暴露完整 `Context`（避免 core 被上层 ctx 结构绑架）。


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
