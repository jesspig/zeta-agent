# RED 反例执行日志索引（T-02 / ST-00）

- 日期：2026-11-26
- 基线：`develop@af37607`；工作树 `feature/evidence-trust-baseline`（T-01 的 4 个提交之上，未提交本次改动）
- 命令：`bun scripts/red-gates.mjs`
- 退出码：`1`
- 汇总：`7 cases / 7 RED / 0 GREEN`

| Case | 关键实际输出（当前生产代码） |
| --- | --- |
| RED-01-loop-decision-end-followup | `streamAssistantCalls: 2`（期望 1）；pre-set follow-up 在 shouldEnd 分支被立即消费 |
| RED-02-fiber-update-active-consumer | `outcome: timeout-500ms`、`settled: false`、consumer 仍 ACTIVE |
| RED-03-fiber-target-change-disposer | 非空 v1→v2 后旧 disposer 调用 `before:0 / after:0` |
| RED-04-research-pipeline-seal-transfer | `pipelinePromoted:true`、`lowLevelPromoteReused:true`（裸 promote 复用成功） |
| RED-05-session-agent-restore | store 已含 `restore-marker`，新 Agent `restored:[]` |
| RED-06-compaction-second-request | `compacted:true`，但 `secondRequestHasRecapMarker:false`、`oldBlockReplaced:false` |
| RED-07-tenant-origin-missing | `resolve({})` 返回 `{userId:"system",spaceId:"default"}` 而非失败关闭 |

每条 case 的完整期望/实际/失败原因/证据路径由 `bun scripts/red-gates.mjs` 运行时打印，此处只做索引。
`needs-fixture.md` 列出不能用当前 API 表达的候选，不计入 RED。

## T-11 / RED-08（NF-02 升级）

- 夹具：`scripts/red-cases/egress-redirect-hop.case.mjs`，loopback HTTP 服务器返回 30x 指向未放行的 `localhost`，不访问外网。
- 实现前实测：`status:200`、第二跳 `/denied` 被触达且 `x-api-key=probe-key` 跨 origin 泄漏 → `[RED] RED-08-egress-redirect-hop`（汇总 8 cases / 4 RED / 4 GREEN，退出码 1）。
- 实现后实测：`error:"EGRESS_DENIED"`、仅 `/start` 被触达 → `[GREEN] RED-08-egress-redirect-hop`（汇总 8 cases / 3 RED / 5 GREEN，退出码 1；RED-04/06/07 仍 RED 属其他任务）。
- RED-01/02/03/05 全程 GREEN，未被本任务改动。
