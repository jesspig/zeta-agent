# 通用框架总览

> **文档定位**：通用框架总览（从 `04-开发框架层设计.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [1 定位与设计目标](#1-定位与设计目标)
- [2 包结构与导出](#2-包结构与导出)

## 1 定位与设计目标

`@zeta-agent/framework` 是**通用框架**：它**由多个内部组件拼装而成**，对外暴露封装好的 facade API。Cordis 论文复刻只是其中**一个组件**（`components/cordis/`，提供 effect/coeffect/fiber 语义），**不是框架全部**——这是与早期草案的关键区别。框架的其他内部组件还包括 events（五模式派发）、scope、seam/registry、loader（配置分层）、HMR、store/link、HealthBoard 等。S12 的 `vendor/cordis/src/*` 是 `cordis` 组件的一手复刻蓝本；其 `packages/boot/*` 等是通用框架其他组件的蓝本。

> **依赖边界（重要）**：本组件是对论文的**自行实现**，**不引入任何上游 Cordis 包**（`cordis`、`@cordisjs/*`、`@deepseek-ai/cordis` 均不进依赖树）。`@zeta-agent/cordis`（及 C 方案下的 `packages/components/cordis/`）只是我们对该组件的命名；S12 源码仅作只读蓝本，不进入构建产物。本文出现的 `@cordisjs/group`、`@cordisjs/include`、`@cordisjs/hmr` 等名称均出自[01 论文精读](../research/cordis-paper-theory.md)对上游 Cordis 的描述，**不是我们的依赖**，对应的实现由我们的 `components/loader`、`components/hmr` 以自研方式提供。

> **API 边界**：上层应用（CLI / TUI / 未来形态）与 Agent 框架**只通过 facade** 使用本框架（`src/index.ts` 导出的 `createContext` / `defineKey` / `defineComponent` / `ctx.use` / `ctx.on` / `loader.load` 等），**不得 import `src/components/**` 内部组件**。内部组件之间可互相组合，但对内不对外。详见 [03 §4](../architecture/framework-model.md#4-两个框架-应用形态组件拼装模型)。

> **HMR 的定位**：HMR 不是开发期可选工具，而是 component loader 的一部分（论文 §5.2 明确把"配置对账 + 热模块替换"列为 Cordis 三层中的第二层）。chord 设计文档同样强调"没有 dev/prod 之分，插件机械是核心机械"（[02 §3](../research/pi-baseline.md#3-earendil-workschord对象运行时与插件)）。因此 HMR 必须在本层实现，并被 agent 运行时（包括自演化）直接使用。

**必须做到的六件事**（与 [03 P1-P6](../architecture/framework-model.md#2-从论文推导出的十条工程原则) 一致）：

1. 所有上下文变更只有一个入口 `ctx.effect`；
2. 逆在施加点返回，按 LIFO 组合，至多执行一次；
3. 组件声明 `inject`（需要）与 `provide`（提供），键带命名空间；
4. target / committed view 记录 provider 的 uid（而非值）；
5. provider 的撤回延迟到消费者去活之后（guard）；
6. 状态机是惯性的：一次转换跑完再检查 target。

**明确不做**：HTTP server、worker 池、Web/终端客户端、业务工具——这些在上层以 facet/插件实现（chord 的"每个实现都是插件"原则，[02 chord 报告 §7](../research/pi-baseline.md)）。对象运行时（§9）作为**可选子路径**提供，最小可用内核只需要 ctx/fiber/loader。


## 2 包结构与导出

```
packages/framework/
  package.json          # @zeta-agent/framework, exports: "." / "./package.json"（facade 唯一出口）
  src/
    index.ts            # 【facade】createContext / defineKey / defineComponent / use / on / loader.load ...
    components/         # 【内部组件】应用与其他框架不得直接 import
      cordis/           #   effect/coeffect/fiber/context/lifecycle（论文复刻组件）
      events/           #   emit/parallel/serial/bail/waterfall + @mode 校验
      scope/            #   ScopeKey / Scoped<T> / scopeTarget / 双路径 teardown
      seam/             #   Service Definition / Provider / Consumer 登记与能力图
      registry/         #   defineRegistry / compose / accepts
      loader/           #   Entry / 配置对账 / realm 重分配 / patch 分层
      hmr/              #   单一队列 HMR + readiness + 模块驱逐（论文 §5.2）
      health/           #   HealthBoard 单写者断言
      store/            #   documents / transactions / watch
      links/            #   memory / ipc / ws link
      objects/          #   contract / object / reference
    testing/            # fake context / 断言 / 汇合性测试工具
```

`package.json` 只依赖可选 peer（`esbuild`、`ws`），与 chord 一致。`sideEffects: false`。**facade 是唯一公开面**：`exports` 只暴露 `.` 与 `./package.json`，不暴露 `./components/**`，从包管理层面阻止应用深入内核。


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
