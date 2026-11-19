# 工具与策略：顺序、流水线与权限

> **文档定位**：工具与策略：顺序、流水线与权限（从 `05-Agent开发框架层设计.md` 拆分/重命名而来，内容保持原样，链接已按新结构重写）。
> **所属索引**：[本目录索引](./README.md) · [总索引](../README.md)
> **来源分级**：一手来源为 [在线论文](https://arxiv.org/abs/2608.25512v1) 与 [GitHub 源码](https://github.com/earendil-works/pi)（逐文件链接见正文）；汇总见 [事实登记](../architecture/fact-registry.md)。

## 目录

- [7 顺序敏感部分：中间件与提示词](#7-顺序敏感部分中间件与提示词)
- [8 工具流水线](#8-工具流水线)
- [9 权限与沙箱 hook](#9-权限与沙箱-hook)

## 7 顺序敏感部分：中间件与提示词

论文 §7.2（[cordis-paper §7.2](../research/cordis-paper-theory.md)）指出：不同键上的操作天然可交换，同键操作需要可交换见证；**有序链不可交换**。

| 机制 | 是否可交换 | 处理方式 |
| --- | --- | --- |
| 工具注册（唯一 id + 逆删除） | ✅ 可交换 | 可任意顺序加载；用 `commutative: true` 声明 |
| 事件监听器注册 | ✅ 可交换 | 但**触发顺序**敏感 → 用显式 `priority` 声明 |
| `beforeToolCall` / `afterToolCall` 钩子 | ❌ 不可交换 | 声明为有序 coeffect（`order` 元数据），按 priority 执行 |
| 提示词 sections 拼接 | ❌ 不可交换 | 按 section key 的声明顺序；借鉴 durable 的 `section/wrapSection` |
| 中间件链（请求改写） | ❌ 不可交换 | 显式顺序；冲突由插件管理器报告 |

**实现策略**：`AgentPluginApi` 的 `addBeforeToolCall` 等接受 `{ priority?: number, order?: string[] }`；顺序敏感插件必须声明 `order`（`["@zeta-agent/framework/permissions", "my-plugin"]`），加载时做拓扑排序；检测到环 → 该插件 `FAILED`，不拖垮其他插件（论文的 failure 扩展）。


## 8 工具流水线

完整保留 pi 的阶段：

```
prepareToolCall:
  查工具（未找到→error result，不进 hook）
  → prepareArguments（兼容 shim）
  → pi-schema 等价校验（validateToolArguments）
  → beforeToolCall 链（block→error result，reason 作文本，可带 terminate）
  → 异常→error result
executePreparedToolCall:
  durationMs 只包 execute()
  onUpdate 回调的 promise 在 settle 后统一 await；迟到更新丢弃
finalizeExecutedToolCall:
  afterToolCall 链按字段覆盖（content/details/usage/terminate/isError）
  structuredContent 规则：after.content ? undefined : result.structuredContent（除非显式给）
emit tool_execution_end（完成顺序）+ 按源码顺序落 toolResult
```

- `executionMode` 与全局 `toolExecution` 决定串行/并行；并行时 preflight 串行、执行 `Promise.all`、结果按源码顺序落盘。
- `terminate`：**仅当整批所有 finalized result 都为 true** 才停止后续 LLM 调用（pi 测试 1964/2022/2135）。
- `runToolCall` 公开 API：复用同一流水线，但**不发事件、不加消息**（codemode 示例依赖）。
- 工具执行以 fiber 插件形式存在时，`execute()` 内的资源获取通过 `ctx.effect` 跟踪；发射操作不跟踪（[cordis-paper-system §12.1](../research/cordis-paper-system.md#12-讨论边界复用权限语言与循环依赖)）。


## 9 权限与沙箱 hook

agent-core 本身**不做权限判断**，只提供插件钩子：

- `beforeToolCall` 链是权限 gate：可 `block`（reason 反馈给模型，可 terminate）。
- **P0 修订（[10 CORE-6](../research/dsh-optimizations.md#3-核心运行时优化core)）**：权限否决必须是**单调 guard**——`ToolGuard = (exec) => string | ToolGuardDenial | undefined`；`undefined` 保留 waterfall 决定，返回 reason **只能收紧权限**。类型上不提供 allow 结果，避免链式 hook 中后执行的 listener 把先前的 deny 翻回 allow（权限提升漏洞）。`beforeToolCall` 的 block 属可协商 waterfall，guard 是不可翻回的否决。补测试："任意 listener 顺序下 deny 不会变回 allow"。
- `afterToolCall` 链做审计与结果改写（decision union：只能替换 content **或** value 之一，见 [10 CORE-5/12](../research/dsh-optimizations.md#3-核心运行时优化core)）。
- 具体策略（路径白名单、只读数据库、命令审批）由上层插件通过 `ctx.intercept` 的元数据实现（[cordis-paper-system §12.3](../research/cordis-paper-system.md#12-讨论边界复用权限语言与循环依赖)）；拦截可在运行时增删而**不触发工具 reload**。
- 真正的不可信代码隔离需要外部沙箱（QuickJS/WASM、进程、容器），agent-core 只提供 `execute` 的边界，不承诺安全。


## 文档关系

| 关系 | 文档 |
| --- | --- |
| 所属目录索引 | [./README.md](./README.md) |
| 全局索引 | [总索引](../README.md) |
| 事实来源 | [事实登记与交叉验证矩阵](../architecture/fact-registry.md) |
