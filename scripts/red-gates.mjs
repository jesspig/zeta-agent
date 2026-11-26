/**
 * RED 反例门（ST-00 / T-02）。
 *
 * 用法：bun scripts/red-gates.mjs
 * 默认不参与 `bun test`：文件名/目录名均不匹配 bun test 的发现规则。
 * 当前生产代码下每个 case 必须为 RED，命令整体退出码为 1；
 * 后续 P0 实现完成后对应 case 应转 GREEN，全部 GREEN 时退出 0。
 */
import { execFileSync } from "node:child_process";

const CASES = [
  "./red-cases/loop-decision-end-followup.case.mjs",
  "./red-cases/fiber-update-active-consumer.case.mjs",
  "./red-cases/fiber-target-change-disposer.case.mjs",
  "./red-cases/research-pipeline-seal-transfer.case.mjs",
  "./red-cases/session-agent-restore.case.mjs",
  "./red-cases/compaction-second-request.case.mjs",
  "./red-cases/tenant-origin-missing.case.mjs",
  "./red-cases/egress-redirect-hop.case.mjs",
  "./red-cases/plugin-host-escape.case.mjs",
  "./red-cases/durable-idempotent-settle.case.mjs",
  "./red-cases/tenant-realm-breach.case.mjs",
  "./red-cases/daemon-lease-probe-tls.case.mjs",
  "./red-cases/session-cas-lease-and-bad-frame.case.mjs",
  "./red-cases/mcp-schema-oauth.case.mjs",
  "./red-cases/t20-profile-conformance.case.mjs",
  "./red-cases/t22-evidence-observability-orchestration.case.mjs",
];

const { TIMEOUT_MS } = await import("./red-cases/common.mjs");

function summarize(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function runCase(path) {
  const started = Date.now();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`CASE_TIMEOUT_${TIMEOUT_MS}MS`)), TIMEOUT_MS);
  });
  try {
    const mod = await import(path);
    const gate = mod.default;
    const result = await Promise.race([gate.probe(), timeout]);
    const elapsedMs = Date.now() - started;
    const shapeValid =
      result !== null &&
      typeof result === "object" &&
      typeof result.green === "boolean" &&
      "actual" in result &&
      "reason" in result &&
      "evidence" in result;
    if (!shapeValid) {
      return {
        id: gate.id ?? path,
        status: "RED",
        expectation: gate.expectation ?? "",
        actual: summarize(result),
        reason: "case 返回值不符合 {green, actual, reason, evidence} 契约",
        evidence: path,
        elapsedMs,
      };
    }
    return {
      id: gate.id,
      status: result.green ? "GREEN" : "RED",
      expectation: gate.expectation,
      actual: summarize(result.actual),
      reason: result.reason,
      evidence: result.evidence,
      elapsedMs,
    };
  } catch (error) {
    return {
      id: path,
      status: "RED",
      expectation: "case 应正常执行并给出期望/实际对比",
      actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      reason: "case 执行异常（视为反例失败，不视为通过）",
      evidence: path,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const path of CASES) {
  results.push(await runCase(path));
}

console.log("=== RED 反例门（bun scripts/red-gates.mjs） ===");
let baseline = "unknown";
try {
  baseline = execFileSync("git", ["rev-parse", "--short", "develop"], { encoding: "utf8" }).trim();
} catch {
  // 非 git 环境下保留 unknown，不影响门判定。
}
console.log(`当前基线：develop@${baseline}；目标：每个 case 当前 RED，实现完成后转 GREEN`);
for (const result of results) {
  console.log("");
  console.log(`[${result.status}] ${result.id} (${result.elapsedMs}ms)`);
  console.log(`  期望: ${result.expectation}`);
  console.log(`  实际: ${result.actual}`);
  console.log(`  失败原因: ${result.reason || "无"}`);
  console.log(`  证据: ${result.evidence}`);
}

const red = results.filter((result) => result.status === "RED").length;
const green = results.length - red;
console.log("");
console.log(`=== 汇总: ${results.length} cases / ${red} RED / ${green} GREEN ===`);
console.log("needs-fixture 清单见 scripts/red-cases/needs-fixture.md（不计入 RED）");

// 显式退出：部分 case 的当前生产实现会留下未结束的定时器/挂起 Promise。
process.exit(red > 0 ? 1 : 0);
