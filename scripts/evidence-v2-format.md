# 验收与发布证据 v2 格式说明（T-01）

本报告格式用于把验收/发布结论绑定到同一次运行的 commit、runId、日志哈希与退出码。
历史报告不得手工合并或改判；Markdown 一律从 JSON 生成。

## 1. acceptance 报告：`reports/acceptance-report.json`

- `schema`: 固定 `zeta-acceptance/2`。
- `run`:
  - `id`: 本次运行 id（`--run-id` 或自动生成）。
  - `baseline.ref/commit/sourceTreeHash/worktreeClean`: commit 来自 git 实测或 `--baseline`，tree 来自 `git rev-parse <commit>^{tree}`，`worktreeClean` 来自 `git status --porcelain`。
  - `toolchain`: bun/node/packageManager 实测值。
  - `generator.version/sourceHash`: 生成器版本与 `scripts/acceptance-report.mjs` 自身 SHA-256。
  - `criterionVersion`、`generatedAt`。
- `items[]`: 每项含 `id`、`criterionVersion`、`status`、`commands[]`、`evidence[]`、`summary`、`reasonCodes`、`note`。
  - `status`: `pass` / `fail` / `blocked` / `unverified`。命令非零退出、信号、超时、期望标记缺失为 `fail`；spawn 失败为 `blocked`。
  - `commands[]`: `argv`、`cwd`、`exitCode`、`signal`、`timedOut`、`log.path`、`log.sha256`、`log.bytes`。日志落盘在 `reports/evidence/acceptance/<runId>/<Axx>.<n>.log`。
  - `summary`: 从本次日志末尾连续匹配行提取，保留原始换行，可在原始日志中逐字定位；Markdown 中以 `<br>` 呈现。
- `ciEvidence`: `verifier`、`result`、`runs[]`、`reasonCodes`、`checks`。未提供本地证据时 `result=unverified`（`CI_EVIDENCE_NOT_PROVIDED`）；提供则强制校验 headSha、conclusion、required jobs、artifact digest。
- `partialRerun`: `mode`（`partial`/`full`）、`reusedIds`、`rerunIds`、`reasonCodes`。
- `acceptedRisks[]`: 仅记录，不参与状态判定，绝不把 A 项改为 pass。

## 2. CI 证据输入（本地 JSON，无网络）

`--ci-evidence=<path>` 读取如下结构，`bun scripts/ci-evidence.mjs <path> --baseline=<sha>` 可单独验真：

```json
{
  "schema": "zeta-ci-evidence/1",
  "run": { "id": 12345, "headSha": "<baseline commit>", "status": "completed", "conclusion": "success" },
  "requiredJobs": ["build", "test"],
  "jobs": [{ "id": "build", "conclusion": "success" }, { "id": "test", "conclusion": "success" }],
  "artifacts": [{ "name": "acceptance", "digest": "sha256:<64 hex>", "path": "reports/..." }],
  "expectedDigests": { "acceptance": "sha256:<64 hex>" }
}
```

校验失败原因码：`CI_HEAD_SHA_MISMATCH`、`CI_RUN_CONCLUSION_NOT_SUCCESS`、`CI_REQUIRED_JOB_NOT_SUCCESS:<id>`、
`CI_ARTIFACT_DIGEST_MISMATCH:<name>`、`CI_ARTIFACT_FILE_DIGEST_MISMATCH:<name>`、`CI_RUN_ID_MISSING` 等。
`expectedDigests` 省略时回退到 JSON 内同名节点；`path` 存在时还会对本地文件实际字节计算 SHA-256。

## 3. 部分重跑规则

只有同时满足：`schema=zeta-acceptance/2`、baseline commit/ref/sourceTreeHash 相同、`criterionVersion` 相同、
`generator.version/sourceHash` 相同、旧报告每项命令日志 `sha256` 存在且与落盘字节一致，才允许复用未请求项；
任一项不满足即全量重跑（`reasonCodes` 给出具体错配项）。

## 4. 发布报告：`reports/release-candidate.json`

固定 `schema=zeta-release/2`，新增 `baselineCommit`、`baselineRef`、`sourceTreeHash`、`worktreeClean`、
`runId`、`buildCommand`、`generatedAt`。`--baseline=<sha>` 显式指定 commit；未指定时从 git HEAD 实测，不硬编码。
`bun scripts/release-check.mjs --baseline=<sha>` 不访问网络。

## 5. 退出码口径

- 任一 item 为 `fail`/`blocked`/`unverified` → 退出 1。
- `ciEvidence.result=fail`（提供证据但验真失败）→ 退出 1。
- `ciEvidence.result=unverified`（未提供本地证据）记录为待裁决，不单独改变退出码，以保持无参数全量入口可用；
  该口径需最终验收（T-25）确认。

## 6. 故障注入证据重建

1. 运行单测：`bun test scripts/acceptance-report.spec.mjs scripts/ci-evidence.spec.mjs scripts/release-check.spec.mjs`。
2. 其中 `main 故障注入` 用退出码 7 的假命令生成报告，断言退出码 1、日志 SHA-256 绑定、Markdown 摘要片段逐行可在原始日志定位。
3. 历史报告不参与本次重建；部分重跑只复用哈希校验通过的旧日志。
