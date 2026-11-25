# zeta-agent

万物皆插件的 Agent Harness：以 Cordis 论文的 effect/coeffect/fiber 语义为核心，采取「两个框架 + facade + 应用形态」的结构。

## 定位

zeta-agent 是对 Cordis 论文与 pi（coding-agent）设计的一套自行实现与复刻：

- **不引入任何上游 Cordis 包**（`cordis`、`@cordisjs/*`、`@deepseek-ai/cordis` 均不进依赖树）；`packages/components/cordis/` 是对论文的自行实现命名。
- **两个框架**：`@zeta-agent/framework`（通用框架，effect/fiber/loader/HMR）与 `@zeta-agent/agent-framework`（agent 运行时、事件协议、工具与会话）。
- **facade 边界**：上层应用只通过 facade 包使用框架，不 import 组件内部；架构守护脚本（`scripts/guard-architecture.mjs`）静态强制。
- **可插拔 TUI**：`@zeta-agent/tui` 以 OpenTUI + SolidJS 为默认且唯一发布实现；`RendererBackend` 与 `createTui({ backend })` 允许自定义 backend 接管完整交互（帧/事件/输入/resize/退出），slots 与 keymap 可热更新。

## 架构

```
packages/
  framework/           通用框架 facade（createContext / defineComponent / ctx.use / loader）
  agent-framework/     agent 运行时、AgentEvent 协议、工具管线、会话与压缩
  agent/               createAgent facade，装配 capabilities/onEffect/addRedactor
  tui/                 OpenTUI 唯一实现 + RendererBackend seam + createTui
  components/          cordis / events / capabilities / loader / observability / security 等独立组件
  agent-components/    agent 侧组件聚合出口
  deploy/              部署形态
  testing/             fake context 与汇合性测试工具
apps/
  zeta-cli/            zeta 命令入口（TUI / headless / json / rpc）
```

详细设计见 [`docs/desgin/`](docs/desgin/README.md)：[TUI 设计](docs/desgin/agent/tui.md)、[框架总览](docs/desgin/framework/overview.md)、[审查记录](docs/desgin/delivery/review-record.md)。

## 快速开始

```bash
bun install --frozen-lockfile
bun run check            # 架构守护 + 构建 + 类型 + 测试
bun run zeta             # 启动 TUI（默认）
bun run zeta --headless "提示词"   # 无 TTY 打印模式（CI 可用）
```

模型配置（TUI 与 headless 通用）：设置 `ZETA_BASE_URL` / `ZETA_API_KEY` / `ZETA_MODEL` 三项使用 OpenAI 兼容模型；缺失时回退 echo（无网络）。密钥勿写入仓库。

产品 profile：`local-safe`（默认）与 `local-full`（显式 opt-in），未知值直接失败关闭；研究轨、daemon/remote 与跨进程对象默认不装配，启用路径不可绕过护栏。公开 API 与 profile 明细见 [API 与测试](docs/desgin/framework/api-and-testing.md)。

## 发布与验收

- 发布候选版本：`zeta 0.1.0`（CLI `--version` 实测）；校验：`bun scripts/release-check.mjs`，产物说明与回滚步骤见 [release-runbook.md](docs/desgin/delivery/release-runbook.md)。
- 发布校验：运行 `bun scripts/release-check.mjs` 生成版本、架构、SHA-256、SBOM、迁移/回滚与平台矩阵报告；生成物位于被 Git 忽略的 `reports/`。
- 最终验收：运行 `bun scripts/acceptance-report.mjs` 生成 A1–A40 逐项 pass/fail 与命令证据；生成物位于 `reports/`，能力现状见 [capability-matrix.md](docs/desgin/delivery/capability-matrix.md)。
- 本机仅 `win32-x64` 完成安装/启动/升级/回滚冒烟；其余 11 个 target 为 skipped，需 CI 三平台矩阵补证。`remote` 已补齐 wire-level gRPC transport；release-age 的 3 个过新依赖按用户裁决接受为已知风险。

## 历史归档

上一轮任务的完整快照只读保留在 [`.handoff/archive/`](.handoff/archive/2026-11-20-1659-zeta-agent-harness/manifest.json)，包含当时的规格、计划、图、状态与证据（85 文件）。当前任务的规划与证据见 `.handoff/`（该目录不入库）。
