# 全量质量门报告

- 生成时间：2026-11-25T06:44:51.676Z
- 环境：win32/x64 · bun 1.4.2
- 总计：55 个门；pass 43 / fail 0 / skipped 11 / unverified 1

| 类别 | 门 | 状态 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| tests | tests:unit | pass | local | 92 pass / 0 fail / 0 skip / 11 files，724ms |
| tests | tests:property | pass | local | 12 pass / 0 fail / 0 skip / 3 files，811ms |
| tests | tests:contract | pass | local | 28 pass / 0 fail / 0 skip / 5 files，696ms |
| tests | tests:e2e | pass | local | 9 pass / 0 fail / 0 skip / 5 files，656ms |
| tests | tests:pty | pass | local | 19 pass / 0 fail / 1 skip / 3 files，520ms |
| tests | tests:crash | pass | local | 19 pass / 0 fail / 0 skip / 4 files，1208ms |
| tests | tests:sandbox | pass | local | 27 pass / 0 fail / 0 skip / 4 files，534ms |
| tests | tests:network | pass | local | 25 pass / 0 fail / 0 skip / 5 files，595ms |
| tests | tests:conformance | pass | local | 17 pass / 0 fail / 0 skip / 4 files，901ms |
| security | security:permissions | pass | local | 23 pass / 0 fail / 0 skip / 5 files，459ms |
| security | security:egress | pass | local | 18 pass / 0 fail / 0 skip / 3 files，468ms |
| security | security:credentials | pass | local | 15 pass / 0 fail / 0 skip / 4 files，425ms |
| security | security:audit | pass | local | 20 pass / 0 fail / 0 skip / 5 files，1531ms |
| security | security:extensionSandbox | pass | local | 24 pass / 0 fail / 0 skip / 4 files，509ms |
| security | security:redTeam | pass | local | 15 pass / 0 fail / 0 skip / 4 files，522ms |
| performance | perf-first-frame | pass | local | 发布二进制 184/188/1782ms，中位 188ms |
| performance | perf-effect | pass | local | 6 pass / 0 fail / 0 skip / 2 files，412ms |
| performance | perf-reload | pass | local | 14 pass / 0 fail / 0 skip / 3 files，693ms |
| performance | perf-guard-wait | pass | local | 12 pass / 0 fail / 0 skip / 2 files，447ms |
| performance | perf-long-session | pass | local | 15 pass / 0 fail / 0 skip / 2 files，477ms |
| performance | perf-budget:firstFrameMs | pass | local | 实测 188 / 阈值 2000 |
| performance | perf-budget:effectMs | pass | local | 实测 412 / 阈值 1300 |
| performance | perf-budget:reloadMs | pass | local | 实测 693 / 阈值 2400 |
| performance | perf-budget:guardWaitMs | pass | local | 实测 447 / 阈值 1600 |
| performance | perf-budget:longSessionMs | pass | local | 实测 477 / 阈值 1400 |
| performance | perf-budget:memBytes | pass | local | 实测 80384000 / 阈值 268435456 |
| performance | perf-budget:tokenCost | pass | local | 实测 24595 / 阈值 32000（token 为同源估算器结果） |
| authenticity | authenticity-ratchet | pass | local | 284 files / publicApi 59 / async 189 / parallel 33 / fault 40 / mockOnly 0 / fakeTimer 1 |
| authenticity | authenticity:packages/agent/src/plugins/mcp/conformance.spec.ts | pass | local | packages/agent/src/plugins/mcp/conformance.spec.ts 命中 createMcpProtocol, await, expect( |
| authenticity | authenticity:packages/components/security/src/egress.dataplane.spec.ts | pass | local | packages/components/security/src/egress.dataplane.spec.ts 命中 assertEgressAllowed, await, expect( |
| authenticity | authenticity:packages/agent/src/tools/backend.contract.spec.ts | pass | local | packages/agent/src/tools/backend.contract.spec.ts 命中 await, expect(, rmSync |
| authenticity | authenticity:packages/agent/src/assembly/runtime.session-store.spec.ts | pass | local | packages/agent/src/assembly/runtime.session-store.spec.ts 命中 await, expect(, rmSync |
| authenticity | authenticity:packages/agent/src/plugins/permissions/approval.spec.ts | pass | local | packages/agent/src/plugins/permissions/approval.spec.ts 命中 await, expect( |
| authenticity | authenticity:packages/tui/src/osc-security.spec.ts | pass | local | packages/tui/src/osc-security.spec.ts 命中 expect( |
| authenticity | authenticity:packages/agent/src/facade.tenant.spec.ts | pass | local | packages/agent/src/facade.tenant.spec.ts 命中 Promise.all, await, expect( |
| authenticity | authenticity:real-fault-injection | pass | local | 子进程退出码 0；INJECT_OK |
| platform | platform:target-matrix | pass | local | 配置 12 个 / deploy 12 个；linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, linux-x64-baseline, linux-arm64-baseline, darwin-x64, darwin-arm64, darwin-x64-baseline, win32-x64, win32-arm64, win32-x64-baseline |
| platform | platform:ci-matrix-config | pass | local | .github/workflows/quality-gates.yml 含 3 平台与 12 target；CI 未在本机执行 |
| platform | platform:linux-x64 | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:linux-arm64 | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:linux-x64-musl | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:linux-arm64-musl | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:linux-x64-baseline | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:linux-arm64-baseline | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:darwin-x64 | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:darwin-arm64 | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:darwin-x64-baseline | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:win32-x64 | pass | local | manifest/digest/架构校验通过（098330114fc6…，检测 x64）；本机真实启动通过 |
| platform | platform:win32-arm64 | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:win32-x64-baseline | skipped | cross-platform | 本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass |
| platform | platform:host-lifecycle | pass | local | PASS install 1.0.0 digest=c658a85c3849 start=ok \| PASS upgrade 1.0.0 -> 1.1.0 digest=c658a85c3849 start=ok \| PASS rollback 1.1.0 -> 1.0.0 digest=c658a85c3849 start=ok \| smoke-local: 安装/升级/rollback 均通过真实单文件启动（exit=0） |
| supply-chain | supply:sbom | pass | local | 120 个第三方组件（下限 120），全部带 sha512 完整性摘要；来源 bun.lock |
| supply-chain | supply:dependency-policy | pass | local | 16 个 package.json 无禁用依赖 |
| supply-chain | supply:frozen-lockfile | pass | local | bun install --frozen-lockfile exit=0 |
| supply-chain | supply:release-age | unverified | network | 已核验 5 / 跳过 0；过新 @opentui/solid@0.9.3, solid-js@1.9.20, turbo@2.11.13 |

## 分类汇总

- tests: pass 9 / fail 0 / skipped 0 / unverified 0
- performance: pass 12 / fail 0 / skipped 0 / unverified 0
- security: pass 6 / fail 0 / skipped 0 / unverified 0
- platform: pass 4 / fail 0 / skipped 11 / unverified 0
- supply-chain: pass 3 / fail 0 / skipped 0 / unverified 1
- authenticity: pass 9 / fail 0 / skipped 0 / unverified 0
