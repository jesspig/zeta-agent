# 发布候选校验报告

- 生成时间：2026-11-25T07:52:43.390Z
- 发布版本：zeta 0.1.0（来源 apps/zeta-cli/src/index.ts 的 VERSION 与二进制 --version 实测）
- 宿主 target：win32-x64
- 二进制 SHA-256：098330114fc6de1189d5deb2956a496c6cd23417eabbb2d4dfcf7ad4ffb946e2

| 检查项 | 状态 | 明细 |
| --- | --- | --- |
| version | pass | exit=0 output=zeta 0.1.0 |
| artifact | pass | win32-x64 zeta-win32-x64.exe sha256=098330114fc6de1189d5deb2956a496c6cd23417eabbb2d4dfcf7ad4ffb946e2 arch=x64 embedded=2 |
| sbom | pass | schema=zeta-sbom-1 components=150 无完整性摘要=0 |
| migration-rollback | pass | 安装/升级/回滚与校验命令齐全 |
| platform-matrix | pass | 宿主 win32-x64 pass；非宿主 skipped=11 |

汇总：pass=5 fail=0 非宿主 skipped=11

## 非宿主 target（skipped，不计 pass）

- linux-x64: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- linux-arm64: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- linux-x64-musl: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- linux-arm64-musl: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- linux-x64-baseline: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- linux-arm64-baseline: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- darwin-x64: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- darwin-arm64: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- darwin-x64-baseline: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- win32-arm64: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）
- win32-x64-baseline: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）

## 待裁决

- release-age: @opentui/solid@0.9.3, solid-js@1.9.20, turbo@2.11.13（T-26 已标 unverified，未改阈值）
