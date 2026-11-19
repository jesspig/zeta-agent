# 可观测性设计（缺口 2 补全）

> 文档编号：framework 篇　|　主题：补全可观测性缺口——结构化日志、因果 ID、trace/metric、脱敏、SLO、Debug HUD
> 一手来源：[cordis logger.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/logger.ts)、[opencode observability](https://github.com/anomalyco/opencode/blob/dev/packages/util/src/observability.ts)（默认分支 dev）、[coze middleware/log.go](https://github.com/coze-dev/coze-studio/blob/main/backend/api/middleware/log.go)
> 参考汇总：[research/platform-engineering.md §2](../research/platform-engineering.md#2-可观测性缺口-2)
> 所属索引：[framework/README.md](./README.md)　|　上游：[cordis-source-verification.md](../research/cordis-source-verification.md)

## 目录

- [1 设计原则](#1-设计原则)
- [2 结构化日志与因果 ID](#2-结构化日志与因果-id)
- [3 trace：effect 元树即 span 树](#3-traceeffect-元树即-span-树)
- [4 metric 与 SLO](#4-metric-与-slo)
- [5 脱敏](#5-脱敏)
- [6 Debug HUD 与诊断](#6-debug-hud-与诊断)
- [7 观测不破坏 Thm 80](#7-观测不破坏-thm-80)
- [8 API 草案](#8-api-草案)
- [9 交叉引用与验证](#9-交叉引用与验证)

---

## 1 设计原则

1. **默认 no-op、可热替换**：可观测性是插件，不是内核 I/O（呼应 [P9](overview.md#1-定位与设计目标)）；L1 只在 effect/fiber 边界 emit 结构化事件，具体 sink 由插件提供；
2. **依赖 OTel ≠ 有可观测性**：coze-studio 把 otel 全标 `// indirect` 却零埋点、`GetTraceSDK` 是空桩——我们不重蹈覆辙，必须有真实埋点与类型测试；
3. **优雅降级**：OTLP 配置失败退回本地文件日志（`Layer.catchCause(() => local)`），绝不拖垮启动（opencode）；
4. **脱敏在源头**：coze 只在展示层掩码、日志层裸奔；我们在事件总线与日志 sink 前统一脱敏；
5. **观测不改变观察状态**：日志/trace/metric 是旁路，不进入 coeffect context Σ，不破坏 Thm 80 汇合判据。

## 2 结构化日志与因果 ID

官方 cordis 的 `Message` 结构（[logger.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/logger.ts)）每条日志带 `fiber: WeakRef<Fiber>`——**插件级归因**；opencode 的 `runID()` 懒生成 8 位 UUID（workerd 禁全局随机）。我们合并两者：

```ts
interface LogMessage {
  sn: number; ts: number;
  level: 'error'|'warn'|'info'|'debug';
  name: string;              // hyphenate(fiber.name)，可 ctx.intercept('logger',{name,level}) 覆盖
  runId: string;             // 跨进程因果 ID（懒生成，如 crypto.randomUUID().slice(0,8)）
  tenantRealm?: symbol;      // 多租户归因（[security.md §多租户](../agent/security.md)）
  fiber?: WeakRef<Fiber>;    // 插件/component 归因
  args: unknown[];
}
```

- **Formatter**：`timestamp level run <flattened k=v>`，`flatten(WeakSet)` 防循环引用，含空白/引号的值 `JSON.stringify`（opencode）；
- **文件 sink**：就地压缩而非轮转（多进程同 fd + O_APPEND，rename 会甩到已 unlink 的 inode），`mkdir` 原子锁 + stale 清理；
- **Exporter 扩展点**：`ctx.logger.exporter(e): Disposable`，ConsoleExporter 是普通可配置组件（cordis logger-console）。

## 3 trace：effect 元树即 span 树

**关键洞察**：cordis 官方 `getEffects(): EffectMeta[]` 返回带 label 的 effect 树（`{label, children}`），fiber 本身有 parent 关系——这就是天然的 span 树，补 label 即可零成本获得 trace，无需另建一套。

```ts
interface EffectMeta { label: string; children: EffectMeta[] }
// ctx.effect(cb, label) 注册时自动建 span
// span 属性：plugin.id / fiber.uid / gen_ai.tool.name / tenant.realm
```

OTLP 适配器（来自 opencode [otlp.ts](https://github.com/anomalyco/opencode/blob/dev/packages/util/src/observability/otlp.ts)）：
- `resource()`：`service.name`、`deployment.environment.name=channel`、`opencode.client/run`、`service.instance.id`；
- 必须注册全局 AsyncLocalStorageContextManager 才能让 AI SDK 的 span 正确挂父；
- `/v1/logs` + `/v1/traces`；5 个重型包动态 import；
- **类型测试**：断言 span 真的发到 `/v1/traces`，而非仅"依赖存在"。

### 3.1 完整证据落盘与非马尔可夫检索（SE-M1/M2/M3，来源 [harness-optimization-papers.md §2](../research/harness-optimization-papers.md#2-meta-harness完整证据与非马尔可夫检索)）

> Meta-Harness（arXiv:2603.28052）证明：span 若只进 OTLP 被聚合成指标/摘要，等价于其失败消融档——**Scores+Summary 最佳 38.7 反低于 Scores-only 41.3，完整 traces 达 50.0**。论文用 10.0 MTok/iter（比既有方法高三个数量级）+ 每轮读 82 个文件的非马尔可夫检索。

**证据必须完整落盘**：每候选一目录，含 code / scores / traces（prompts / tool calls / model outputs / state updates），层级化 + JSON + 正则友好命名；span 不只进 OTLP sink。这是旁路（[§7](#7-观测不破坏-thm-80)），不入 coeffect context Σ。

**两类压缩必须区分**（SE-M2）：对话上下文可压；**evidence store 禁止有损摘要**。`RedactorPlugin`（§5）只脱敏不裁剪诊断字段；`addContextTransform` 必须声明不可压字段。

**非马尔可夫检索 seam**（SE-M3，本次发现的最大缺口）：

```ts
interface ExperienceStore {
  query(opts: { candidate?: string; kind: 'code'|'score'|'trace'; regex?: string }): AsyncIterable<Evidence>;
  frontier(metric: string): Candidate[];        // Pareto 前沿
  diff(a: string, b: string): { code: string; result: string };
}
// 可选查询 CLI：列 frontier / top-k / 两轮 diff（regex 友好，供 proposer 用 grep/cat 检索）
ctx.set(experienceKey, store);   // 旁路服务，不进 Σ
```

这补齐了我们相对 harness²（固定 Evidence-as-files 流程）与 DREAM-RSI（顺序重放）的第三端：**任意历史候选的非马尔可夫检索**。注意：Meta-Harness 依赖真实 search-set 评估，**不能套用 DREAM-RSI 的 FrozenStore 冻结重放做评分**（[harness-optimization-papers §5](../research/harness-optimization-papers.md#5-诚实的边界)）。

## 4 metric 与 SLO

- cordis 官方无 metric/trace；opencode 用 OTel；coze 只有 `code.WithAffectStability(bool)` 但无消费点；
- 我们定义 `SLOError`：`defineErrorCode(code,{affectStability:true})` 的错误喂给 SLO 错误率指标（见错误模型文档）；
- metric 分类：effect 派发延迟、hook 链编译耗时、reload 延迟、工具执行时长（已有 `durationMs`）、事件循环 p99（Debug HUD）；
- **上下文成本旁路 metric**（CT-6，来源 [harness-optimization-papers §3.1](../research/harness-optimization-papers.md#3-you-dont-need-long-context压缩与-sssm)）：`liveContextTokens / peakContextTokens / compactionCount / estimatedOptimizedCost`。成本按 arXiv:2611.05306 Appendix B 线性插值（r=0.20，Opus $25/M、GPT $20/M），**必须标注为估算模型而非实测账单**；不 `ctx.set` 进 Σ。论文实证 256K→16K 成本降 2.2×–8.8×、延迟侧约 2×——这些 metric 让 performance budget 成为可测闭环。

## 5 脱敏

`RedactorPlugin` 在事件总线与日志 sink 前注册：
```ts
redactRules: [
  { jsonPath: '$.apiKey', mode: 'mask' },
  { regex: /sk-[A-Za-z0-9]+/g, replacement: '[REDACTED]' },
  { field: 'authorization', mode: 'drop' },
]
```
默认屏蔽 apiKey/token/password/Authorization/cookie/credential（coze redactConfig 的关键词表）。凭证值永不进 label（OpenSandbox egress 的做法），域名/目标永不成为 metric label（避免高基数与泄漏）。

## 6 Debug HUD 与诊断

来自 opencode [devtools-bar.tsx](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/devtools-bar.tsx)：
- `monitorEventLoopDelay({resolution:20})` + `cpuUsage()` + `memoryUsage().rss`，2s 采样 / 30s 保留，展示 p99；
- `runtimeStatus()` 阈值：delay ≥100ms=high、≥20ms=medium；
- `TimeToFirstDraw` 组件；`dump()` 导出 session/events/mcp/plugins/theme 快照到 `0600` 临时文件；
- `DevTools.register({id,title}).set(key,value)` 简易注册表。

## 7 观测不破坏 Thm 80

论文 Thm 80 说"最终状态只取决于最终配置"。观测数据若写入 Σ（coeffect context）会改变观察状态、破坏汇合判据。约束：
- 日志/trace/metric 走**旁路 sink**，不 `ctx.set` 进 context；
- effect label 是元数据，不参与 `notify` 的 satisfaction 计算；
- 汇合测试（[roadmap A3](../delivery/roadmap.md#4-验收标准)）须断言"有无观测时观察状态一致"。

## 8 API 草案

```ts
defineServicePlugin({
  name: 'observability',
  keys: [TraceKey, MetricsKey, LogKey],
  default: noop,                      // 默认禁用，可由 --patch 换 OTLP 实现
  install(api) {
    api.onEffect((meta) => spanFromEffectMeta(meta));  // effect 元树 → span
    api.addRedactor(defaultRules);
    return () => api.removeAll();
  }
});
ctx.observability.export({ format: 'otlp'|'file', endpoint?, redact? });
```

## 9 交叉引用与验证

| 本文结论 | 上游来源 | 验证 |
| --- | --- | --- |
| 结构化日志 + fiber 归因 | cordis logger.ts | 日志含 runId/fiber |
| OTLP 优雅降级 | opencode otlp.ts | 注入失败配置仍启动 |
| effect 元树即 span | cordis fiber.ts getEffects | span 父子与 fiber 树一致 |
| 脱敏源头化 | coze 反面教材 | 日志无明文密钥 |
| 观测旁路 | 论文 Thm 80 | 汇合测试含观测开关 |

**总索引**：[README.md](../README.md)　|　**缺口来源**：[platform-engineering.md](../research/platform-engineering.md#2-可观测性缺口-2)
