# 发布、迁移与回滚 Runbook

> **适用范围**：zeta-agent 本地单文件发布物（12 target 矩阵）与 local/daemon/remote 三态的升级/回滚操作。
> **基线**：`9b6f231`（T-26），2026-11-25。证据见 [`reports/quality-gates-report.md`](../../../reports/quality-gates-report.md) 与 [`reports/release-candidate.md`](../../../reports/release-candidate.md)。

## 前置校验

1. `bun install --frozen-lockfile`
2. `bun run check`（架构守护 + 构建 + 类型 + 全量测试 + 质量门）
3. `bun scripts/release-check.mjs`（版本、架构、SHA-256、SBOM、迁移/回滚说明、平台矩阵证据）

发布校验失败时不得安装或升级；报告中 `fail` 必须清零，`skipped` 只代表本机未覆盖的平台。

## 安装

1. `bun scripts/build-local.ts --target=<target>` 构建目标产物；输出位于 `dist/local/<target>/`，含二进制与 `manifest.json`。
2. `bun scripts/release-check.mjs` 核对版本与宿主/嵌入资源架构；非宿主 target 只做静态校验，启动冒烟由对应平台 CI 执行。
3. `bun scripts/smoke-local.ts` 在宿主上执行 install → start（`--version`）真实单文件启动冒烟。
4. 将 `dist/local/<target>/` 整体复制到目标机的发布目录；保留上一版发布目录作为回滚源。

## 升级

1. 记录当前 `current.json` 中的版本与 digest（`scripts/smoke-local.ts` 的 `currentRelease` 同款逻辑）。
2. 构建/获取目标版本产物，执行 `bun scripts/release-check.mjs`。
3. `bun scripts/smoke-local.ts` 验证 upgrade → start 后版本递增且 digest 与新产物一致。
4. 升级窗口内保留上一版二进制与 manifest；`configDigest` 使用 canonical encoding + SHA-256，配置漂移会使升级后探针校验失败并阻止切换。

## 回滚

1. 若升级后 readiness/liveness 或 `configDigest` 不匹配，立即停止流量并执行 `bun scripts/smoke-local.ts` 的 rollback 路径（验证 `1.1.0 → 1.0.0` 版本回退、digest 复原、二进制可启动）。
2. 手动回滚时恢复上一版发布目录，并确认 `current.json` 的版本与 SHA-256 与备份 manifest 一致。
3. 回滚后重跑 `bun scripts/release-check.mjs` 与 `bun scripts/smoke-local.ts`；仍失败则保持上一稳定版并上报阻断。

## 平台矩阵与已知限制

- 支持 target：linux-{x64,arm64,x64-musl,arm64-musl,x64-baseline,arm64-baseline}、darwin-{x64,arm64,x64-baseline}、win32-{x64,arm64,x64-baseline}。
- 本机仅 win32-x64 有可运行产物；其余 11 个 target 在最终报告中为 **skipped**，不计 pass，由 `.github/workflows/quality-gates.yml` 的三平台矩阵覆盖。
- `remote` 为 HTTP JSON-RPC + gRPC 风格状态码映射，不是 wire-level gRPC（A30 待裁决）。
- `release-age` 有 3 个过新直接依赖（`@opentui/solid`、`solid-js`、`turbo`），T-26 如实标为 unverified，未篡改阈值，待裁决。
