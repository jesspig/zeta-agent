# 平台工程参考：安全、可观测、多租户、部署、性能、错误恢复

> 文档编号：研究篇 S20-S22　|　主题：三个生产级项目对 7 个覆盖缺口的参考
> 一手来源：
> - S20 [opensandbox-group/OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)（沙箱/egress/凭证/审计/部署）
> - S21 [coze-dev/coze-studio](https://github.com/coze-dev/coze-studio)（生产级平台的强项与反面教材）
> - S22 [anomalyco/opencode](https://github.com/anomalyco/opencode)（**默认分支 dev**：可观测/性能/错误/部署/插件）
> 所属索引：[research/README.md](./README.md)　|　缺口补全落点：[framework/observability.md](../framework/observability.md)、[agent/security.md](../agent/security.md)

## 目录

- [1 三项目各自补哪个缺口](#1-三项目各自补哪个缺口)
- [2 可观测性（缺口 2）](#2-可观测性缺口-2)
- [3 安全（缺口 4）](#3-安全缺口-4)
- [4 多租户（缺口 3）](#4-多租户缺口-3)
- [5 错误处理（缺口 8）](#5-错误处理缺口-8)
- [6 性能（缺口 6）](#6-性能缺口-6)
- [7 部署形态（缺口 7）](#7-部署形态缺口-7)
- [8 建议汇总与落地](#8-建议汇总与落地)
- [9 交叉引用与验证](#9-交叉引用与验证)

---

## 1 三项目各自补哪个缺口

| 项目 | 强项 | 反面教材（明确不照搬） | 主要补的缺口 |
| --- | --- | --- | --- |
| OpenSandbox | 四层纵深隔离、egress 默认拒绝、Credential Vault、进程外审计、守护进程监督 | gVisor+egress 不兼容、私有 netns 不可跨重启恢复 | 4 安全、7 部署 |
| coze-studio | 统一错误码注册中心、Warn/Error/Cancel 部分失败分级、因果 log-id、执行历史 span 树 | OTel 仅依赖未埋点、GetTraceSDK 空桩、日志未脱敏、默认 RCE、硬编码默认密钥、MD5、owner-only ACL、配额不落地、后端无健康探针 | 2 可观测、3 多租户、8 错误、7 部署 |
| opencode | 结构化日志+fiber 无关的 runID、OTLP 优雅降级、AIError 11 类归一化、分层重试、ExecutionLimits、单文件二进制+架构校验、虚拟滚动、性能基准 | — | 2 可观测、6 性能、7 部署、8 错误 |

## 2 可观测性（缺口 2）

**三个项目的共识**：依赖 OTel 不等于有可观测性（coze 全 `// indirect` 无埋点）；日志需结构化 + 因果 ID + 脱敏；OTLP 故障不能拖垮启动。

核心机制（详见 [framework/observability.md](../framework/observability.md)）：
- **结构化日志 + 因果 ID**：opencode `formatStructured` 的 `timestamp level run <k=v>` + `runID()` 懒生成（[logging.ts](https://github.com/anomalyco/opencode/blob/dev/packages/util/src/observability/logging.ts)）；coze 的 `log-id` 贯穿 HTTP 头 `X-Tt-Logid`；
- **优雅降级**：opencode `Layer.catchCause(() => local)`，OTLP 配置失败退回本地文件日志（[otlp.ts](https://github.com/anomalyco/opencode/blob/dev/packages/util/src/observability/otlp.ts)）；
- **fiber 归因**：cordis 官方每条日志带 `fiber: WeakRef<Fiber>`（见 [cordis-source-verification §4.4](./cordis-source-verification.md)），这是"插件级归因"的关键；
- **脱敏**：coze 是反面教材（展示层掩码、日志层裸奔），我们要在事件源头用 `RedactorPlugin` 统一脱敏 apiKey/token/password；
- **effect 元树即 span 树**：cordis `getEffects(): EffectMeta[]` + opencode `withSpan("Plugin.load")`，我们的 fiber 树天然具备，补 label 即可零成本获得 trace；
- **Debug HUD**：opencode `monitorEventLoopDelay` + cpu/rss ring + p99，补 gap 6 运行时可视（[devtools-bar.tsx](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/devtools-bar.tsx)）。

## 3 安全（缺口 4）

**OpenSandbox 是主角**。核心机制（详见 [agent/security.md](../agent/security.md)）：

- **四层纵深防御**：runc → gVisor → Kata(QEMU) → Kata(Firecracker)，每层报告 `active|degraded|unsupported|disabled`，**禁止默认相信**（[hardening_common.go](https://github.com/opensandbox-group/OpenSandbox/blob/main/components/execd/pkg/runtime/hardening_common.go)）；
- **硬化底座**：Landlock 路径白名单（刻意排除全 `/proc` 防凭据窃取）+ seccomp denylist（30+ 系统调用）+ capability bounding set drop + 真实 setuid（[launcher.c](https://github.com/opensandbox-group/OpenSandbox/blob/main/components/execd/native/launcher.c)）；每次工具调用一个 bubblewrap session；
- **egress 默认拒绝**：sidecar 与 workload 共享 netns、唯一 NET_ADMIN 持有者，"nothing to bypass"；三层 DNS/nftables/平台覆盖（平台 deny 永远压过用户 allow）+ L7 MITM（[egress.md](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/network/egress.md)）；
- **Credential Vault**：沙箱内只放 fake 环境变量，真实密钥由 sidecar 按 scheme+host+port+method+path 唯一绑定在出口注入，永不落会话/快照/日志（[credential-vault.md](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md)）；
- **进程外审计**："采样日志不是审计轨迹"——用只读、带 `finalized(rev)` 完整性标记的 sink（[node-agent.md](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/data-plane/node-agent.md)）；
- **能力探测**：依赖沙箱的工具 install() 时必须 `capabilities()` 证明 enforcement 开着，否则 FAILED/降级——禁止"假设已强制"。

**coze 反面教材**：默认 coderunner 走 `direct` 且注释 `// ignore_security_alert RCE`、AES-CBC 硬编码默认密钥、API Key 用无盐 MD5、模型密钥明文落库、无 append-only 审计。我们明确拒绝这些做法。

## 4 多租户（缺口 3）

- **identity + realm 绑定**：`Principal{userId, spaceId, realm}`，启动时 `ctx.isolate(ToolsKey, realmFor(spaceId))`，所有 per-tenant 资源经 realm 解析——避免 coze 的进程级全局单例 `crossdomain.SetDefaultSVC` 与手工 `checkUserSpace`（易漏）；
- **事件级过滤**：cordis 的 `Context.filter` symbol 可按会话过滤 hook，配合 `Scoped<T>` 实现多租户事件路由；
- **配额作为 coeffect**：`QuotaService{check,reserve}` per-space QPS + token budget，withhold 发射前先 reserve——避免 coze 配额只是元数据不落地；
- **经验库隔离**（自演化场景）：per-domain 且 per-mode 各持一个 ExperienceLibrary，只读更早任务（来自 harness² 的 SE-H10）。

## 5 错误处理（缺口 8）

**coze 的强项 + opencode 的强项**（详见 [agent/security.md](../agent/security.md) 错误章节或单独错误模型文档）：

- **统一码表**：coze `Register(code,{msg,affectStability,retryable,level})`，`affectStability` 喂 SLO 错误率（[register.go](https://github.com/coze-dev/coze-studio/blob/main/backend/pkg/errorx/code/register.go)）；opencode `AIError` 11 类 reason tagged union + `isRetryable` 判定表（[errors.ts](https://github.com/anomalyco/opencode/blob/dev/packages/ai/src/schema/errors.ts)）；
- **部分失败分级**：coze `ErrorLevel{Warn,Error,Cancel}`，节点 warn 不终止 flow（`CtxWarnf`）；我们定义 `PartialFailureMatrix[tool]` → `{onError,retryable,maxRetry,compensation}`；
- **分层重试**：opencode 指数+jitter+retry-after cap（15min 防恶意挂起）+ 不可达网络独立预算（1h 窗口/30s gap）+ timeout 限次 + `retryOneShot`（[model-retry.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/model-retry.ts)）；
- **工具失败边界**：opencode `ToolFailure` → `tool-result type:"error"` 让模型自我纠正，非 ToolFailure 视为 defect；用户拒绝以 defect 穿过叶子 mapError，在 executeTool 变 typed；
- **错误携带 DebugURL**：coze `WorkflowError.appendDebug()` 把错误关联到因果 trace（[node.go](https://github.com/coze-dev/coze-studio/blob/main/backend/domain/workflow/entity/vo/node.go)）。

## 6 性能（缺口 6）

opencode 提供完整三件套（预算/profiling/回归门禁）：
- **预算**：`ExecutionLimits{timeoutMs,maxToolCalls,maxOutputBytes}` + `boundOutput` 裁剪 + `revisitBudget=2048` 防边界拷贝爆炸（[codemode.ts](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/src/codemode.ts)）；
- **profiling**：TUI Debug HUD p99；虚拟滚动 `@tanstack/solid-virtual`——我们 `tui.md §4` 的 `For each={messages()}` 全量挂载长会话会炸，必须虚拟化；
- **回归门禁**：`strobe` 基准（中位数+min、warm-up、交错抗 JIT、`--base origin/dev --head .`），CI 卡阈值（[bench.ts](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/script/bench.ts)）；
- **动态降帧**：全屏动画时 `renderer.targetFps` 60→30 临时降级。

## 7 部署形态（缺口 7）

- **单文件二进制 + 架构校验**：opencode `Bun.build({compile,minify,bytecode,splitting})`，12 个 target（os×arch×libc×avx2），原生依赖 `import with {type:"file"}`；`NativeArch.verify()` 校验嵌入镜像架构（真实事故：ARM64 Windows 嵌入 x64 dll）（[build.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/script/build.ts)）；
- **三态运行形态**：① local 内嵌 SQLite + inproc backend（离线可用）；② daemon 本地 HTTP+token（仿 execd `X-EXECD-ACCESS-TOKEN`）；③ remote SDK/gRPC；
- **容器/k8s/守护进程**：OpenSandbox Helm umbrella chart（base→controller→server→ingress→nodeagent）+ CRD；cordis daemon fork/IPC/heartbeat/autoRestart；
- **健康/就绪契约 + 灰度 digest**：框架暴露 `readiness()/liveness()/configDigest()` seam（CLI `--rpc` 可查），部署层配 probes——以 coze 后端无探针、密钥明文注入为反面教材；插件升级沿用已有 `qualify→canary→digest→promote/rollback` 状态机；
- **启动不阻塞首帧**：重模块（OTLP 五件套、Sentry）用 `await import()`，写测试断言"首帧不 await telemetry、产物无顶层 sentry import"。

## 8 建议汇总与落地

三项目合计约 43 条建议（OpenSandbox 13 + coze 14 + opencode 16），按缺口归类后落点如下：

| 落点文档 | 补的缺口 | 主要来源 |
| --- | --- | --- |
| 新建 `framework/observability.md` | 2 可观测 | opencode + coze + cordis logger |
| 新建 `agent/security.md` | 4 安全、3 多租户 | OpenSandbox + coze 反面教材 |
| 新建 `framework/error-model.md`（或在 core-semantics 增章） | 8 错误恢复 | coze errorx + opencode AIError |
| `architecture/engineering.md` 增章 | 6 性能、7 部署 | opencode + OpenSandbox |
| `agent/tui.md` 增章 | 6 性能（虚拟滚动/帧率/HUD） | opencode |
| `capability-reservation.md` 增建议簇 | 全部 | 三项目 |
| `delivery/roadmap.md` 验收 A21+ | 全部 | 三项目 |

**裁决点**：cordis 官方源码验证（[cordis-source-verification.md](./cordis-source-verification.md)）发现 HMR 语义、@mode、撤销顺序等 13 处需修正，我们采用"以一手源码为准纠正 + 保留有理由的偏离并标注"的准则（Bun HMR 路径、形式化 CoeffectKey 保留为自研增强）。

## 9 交叉引用与验证

| 本文结论 | 上游来源 | 下游验证 |
| --- | --- | --- |
| 安全机制 | OpenSandbox docs + code | agent/security.md |
| 可观测机制 | opencode util + coze middleware | framework/observability.md |
| 错误模型 | coze errorx + opencode AIError | error-model |
| 性能/部署 | opencode build/bench + OpenSandbox k8s | engineering.md |
| 默认分支 dev | opencode AGENTS.md:4 | engineering.md 已注明 |

**总索引**：[README.md](../README.md)　|　**事实登记**：[fact-registry.md](../architecture/fact-registry.md)
