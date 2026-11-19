# 安全、多租户与执行边界设计（缺口 4 + 3 补全）

> 文档编号：agent 篇　|　主题：补全安全与多租户缺口——威胁模型、信任边界、执行隔离、egress、凭证、审计、identity/realm、配额、错误模型
> 一手来源：[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)、[coze-studio](https://github.com/coze-dev/coze-studio)（反面教材）、[opencode](https://github.com/anomalyco/opencode)（dev 分支，错误模型）
> 参考汇总：[research/platform-engineering.md §3-5](../research/platform-engineering.md#3-安全缺口-4)
> 所属索引：[agent/README.md](./README.md)　|　关联：[plugin-system.md §7](./plugin-system.md#7-权限信任与沙箱)

## 目录

- [1 威胁模型](#1-威胁模型)
- [2 信任边界登记](#2-信任边界登记)
- [3 执行隔离：ExecutionBackend seam](#3-执行隔离executionbackend-seam)
- [4 egress：发射的门禁](#4-egress发射的门禁)
- [5 凭证：SecretProvider](#5-凭证secretprovider)
- [6 审计：AuditSink](#6-审计auditsink)
- [7 多租户：identity 与 realm](#7-多租户identity-与-realm)
- [8 错误模型（缺口 8）](#8-错误模型缺口-8)
- [9 能力探测](#9-能力探测)
- [10 交叉引用与验证](#10-交叉引用与验证)

---

## 1 威胁模型

来自 OpenSandbox [network-security.md](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/network-security.md)（可直接引用的威胁叙述）：

| 威胁 | 场景 | 我们的防线 |
| --- | --- | --- |
| 生成代码权限提升 | agent 写插件/shell 代码，读取宿主凭据或越权文件 | §3 执行隔离 + §9 能力探测 |
| prompt injection → 工具调用 | 恶意内容诱导 agent 调用危险工具 | `beforeToolCall` 单调 guard（不可翻回）+ §4 egress |
| 数据外泄 | 注入内容诱导把会话/文件 post 到外部站点 | §4 egress 默认拒绝 + §6 审计 |
| 云元数据凭据窃取 | 访问 `169.254.169.254` | §4 egress 端口/目标白名单 |
| 跨租户横向移动 | 扫描其他租户 Pod/数据 | §7 realm 隔离 + 事件级过滤 |
| 供应链投毒 | 第三方插件/解析器含恶意代码 | 来源与签名清单（[roadmap](../delivery/roadmap.md) 灰度 digest） |

**关键认知**：原生 K8s NetworkPolicy 不够（标签静态、沙箱高频、无 FQDN 维度）——需要专注 egress 的 sidecar 模型。

## 2 信任边界登记

```ts
defineKey<TrustBoundary[]>('@zeta-agent/security:boundaries');
interface TrustBoundary {
  kind: 'inproc-fiber' | 'inproc-vm' | 'bubblewrap' | 'container' | 'microvm' | 'remote';
  isolates: ('fs'|'pid'|'net'|'syscall')[];
  survivesKernelExploit: boolean;
  startupMs: number;
  auditSink: AuditSink;
}
```

`inproc-fiber` 只是协作式隔离（fiber 可被恶意代码突破）；真正的安全边界从 `inproc-vm`（QuickJS/WASM）起步。启动期生成 trust manifest 供审计。

**反面教材**：coze-studio 默认 coderunner 走 `direct`（`exec.Command(python3,"-c",code)` + `// ignore_security_alert RCE`）——我们明确禁止 direct 成为默认。

## 3 执行隔离：ExecutionBackend seam

来自 OpenSandbox [OSEP-0013](https://github.com/opensandbox-group/OpenSandbox/blob/main/oseps/0013-isolated-execution-api.md) 的 `Isolator` 接口：

```ts
interface ExecutionBackend {
  name: string;
  capabilities(): LayerState[];           // active|degraded|unsupported|disabled
  run(cmd: Command, opts: RunOptions): Handle;
  createSession?(opts: SessionOptions): Session;  // bubblewrap per-exec
  dispose(): Disposer;
}
ctx.set(executionBackendKey, backend);     // coeffect 注入，应用只依赖 facade
```

四实现：`inproc-vm`（QuickJS/WASM，保留现有 codemode）、`bwrap-session`（每工具调用一个 disposable session，`workspace.mode:'overlay'`、`env_passthrough.mode:'deny'`、`shareNet:false`）、`container`（Docker）、`microvm/remote`（gRPC）。session 句柄与 `ctx.effect` 绑定，工具卸载时逆撤销。

**硬化底座**（来自 [hardening_linux.go](https://github.com/opensandbox-group/OpenSandbox/blob/main/components/execd/pkg/runtime/hardening_linux.go)）：Landlock 路径白名单 + seccomp denylist + capability drop + 真实 setuid；策略经 `memfd_create` 传递不落盘；**任何前置条件缺失一律 degraded 而非静默跳过**。

## 4 egress：发射的门禁

来自 OpenSandbox [egress](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/network/egress.md)：sidecar 与 workload 共享 netns、唯一 NET_ADMIN，"nothing to bypass"。

```ts
ctx.intercept(networkPolicyKey, {
  defaultAction: 'deny',
  egress: [{ action:'allow', target:'api.anthropic.com', ports:[443] }],
  denyAlways: [],            // 平台 floor，普通插件不可覆盖（required root）
  reachablePortsCap: [53,80,443],
});
```

三层强制（DNS 默认拒绝 → nftables → 平台覆盖，平台 deny 永远压过用户 allow）+ L7 MITM。`effects` 插件在 commit 派发前校验发射目标——这是 [O-9 withhold](./plugin-system.md#13-风险与开放问题) 的"目标白名单"补充（现有 withhold 只管时序不管目标）。fail-closed：策略应用失败即 500，绝不以 no-op 放行。

## 5 凭证：SecretProvider

来自 OpenSandbox [Credential Vault](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md)：

```ts
interface SecretProvider {
  issue(input: {name; binding:{scheme,host,path,methods}; ttl}): Placeholder;  // 返回 __zeta_secret_x__
  resolveAtBoundary(placeholder, request): Headers;  // 出口侧替换为真实头，响应脱敏
}
ctx.set(secretsKey, broker);   // 唯一写入者（framework-model §6.1b）
```

- 沙箱内只放 fake 环境变量（如 `ANTHROPIC_API_KEY=fake-key-inside-sandbox`），真实密钥只在 broker；
- 按 scheme+host+port+method+path **唯一绑定**，出口侧注入；
- 写操作带 `expectedRevision`（冲突 412），读一律 sanitized；
- **凭证永不进会话/snapshot/日志**（coze 是反面教材：模型密钥明文落库 + 硬编码默认密钥 + MD5）。

## 6 审计：AuditSink

**"采样日志不是审计轨迹"**（OpenSandbox [execd.md](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/data-plane/execd.md) 原文）——agent 自身日志可被 prompt injection 篡改或采样丢弃。必须进程外、只读、带完整性标记：

```ts
interface AuditSink {
  append(rec: {ts; actor; tenant; pluginId; toolName; argsDigest; decision; resultDigest; causalId}): void;
  finalized(rev): 'complete'|'complete-with-drops'|'incomplete';
}
```

- 只追加、可签名；自演化晋升/withhold 副作用必写；
- 与 operational log 分离；凭证值/域名不进 label；
- 借鉴 nodeagent 的 `finalized.<rev>.json` 标记回答"这些日志可信吗"。

## 7 多租户：identity 与 realm

```ts
interface Principal { userId: string; spaceId: string; realm: symbol }
// 启动时 ctx.isolate(ToolsKey, realmFor(spaceId))，所有 per-tenant 资源经 realm 解析
```

- **避免 coze 的进程级全局单例**（`crossdomain.SetDefaultSVC`）与手工 `checkUserSpace`（分散易漏）；
- **事件级过滤**：cordis `Context.filter` + 我们的 `Scoped<T>` 实现跨租户事件路由；
- **配额作为 coeffect**：`QuotaService{check({tenant,tool}),reserve({tokens,qps})}`，withhold 前先 reserve——避免 coze 配额不落地；
- **经验库隔离**（自演化）：per-domain + per-mode 各持一个，只读更早任务。

## 8 错误模型（缺口 8）

来自 coze errorx + opencode AIError：

```ts
defineErrorCode(code, { msg, affectStability, retryable, level: 'warn'|'error'|'cancel' });
interface AgentError { code; msg; level; retryable; affectStability; cause?; debugURL?; extra }
```

- **AIError 11 类 reason**（opencode）：InvalidRequest/Auth/RateLimit/Quota/ContentPolicy/ProviderInternal/Transport/InvalidProviderOutput/UnknownProvider/Timeout/UnsupportedOperation，带 `isRetryable` 判定表；
- **部分失败分级**（coze `ErrorLevel`）：节点 warn 不终止 turn，`PartialFailureMatrix[tool]` 定义 onError/retryable/maxRetry/compensation；
- **分层重试**（opencode）：指数+jitter+retry-after cap（15min 防恶意）+ 不可达独立预算 + timeout 限次 + `retryOneShot`；
- **工具失败边界**：`ToolFailure` → tool-result error 让模型自我纠正，非 ToolFailure 视为 defect；
- **错误携带 DebugURL** 关联因果 trace。

## 9 能力探测

来自 OpenSandbox：依赖沙箱/密钥/审计的工具插件在 `install()` 时必须调用 `api.capabilities()`：

```ts
api.capabilities(): { isolation: LayerState; seccomp: LayerState; fsConfinement: LayerState;
                      auditSink: LayerState; egressDefaultDeny: LayerState }
```

关键层返回 `unsupported|degraded` 则插件 FAILED 或显式降级——**禁止"假设 enforcement 有效"**。这也是 [plugin-system §8 自演化前置检查](./plugin-system.md#8-自演化与安全管理) 的硬要求。

## 10 交叉引用与验证

| 本文结论 | 上游来源 | 验证 |
| --- | --- | --- |
| 威胁模型 | OpenSandbox network-security.md | 威胁清单覆盖 |
| 执行隔离 seam | OpenSandbox OSEP-0013 | capabilities 状态可核验 |
| egress 门禁 | OpenSandbox egress.md | 发射目标白名单测试 |
| 凭证不持明文 | OpenSandbox credential-vault.md | 日志/snapshot 无明文 |
| 审计完整性 | OpenSandbox node-agent.md | finalized 标记 |
| 错误模型 | coze errorx + opencode AIError | 码表 + 部分失败测试 |
| 能力探测 | OpenSandbox hardening_common.go | 关键层降级即 FAILED |

**总索引**：[README.md](../README.md)　|　**缺口来源**：[platform-engineering.md](../research/platform-engineering.md#3-安全缺口-4)
