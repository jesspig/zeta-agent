import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createVariableLayout, createMetricsSampler, visibleWindow } from "../packages/tui/src/index.ts";
import { createBudgetTracker } from "../packages/agent-framework/src/index.ts";
import { FiberSystem, key } from "../packages/components/cordis/src/index.ts";
import {
  makeGate,
  readConfig,
  root,
  run,
  runTestGroup,
  writeGates,
  writeJson,
} from "./gate-lib.mjs";
import { evaluatePerf } from "../packages/testing/src/quality-gates.ts";

/** 真实执行测试组，记录墙钟耗时作为回归代理；耗时自身也来自实测，不是预算占位。 */
const groups = [
  {
    key: "effectMs",
    id: "perf-effect",
    name: "effect 生命周期耗时",
    files: [
      "packages/components/cordis/src/effect.spec.ts",
      "packages/components/cordis/src/effect.cleanup.spec.ts",
    ],
  },
  {
    key: "reloadMs",
    id: "perf-reload",
    name: "插件/HMR reload 耗时",
    files: [
      "packages/components/loader/src/hmr.spec.ts",
      "packages/components/loader/src/hmr.auto.spec.ts",
      "packages/agent/src/extensions/hot-reload.e2e.spec.ts",
    ],
  },
  {
    key: "guardWaitMs",
    id: "perf-guard-wait",
    name: "guard/审批等待耗时",
    files: [
      "packages/agent/src/plugins/permissions/guard.spec.ts",
      "packages/agent/src/plugins/permissions/approval.spec.ts",
    ],
  },
  {
    key: "longSessionMs",
    id: "perf-long-session",
    name: "长会话虚拟滚动/外置耗时",
    files: [
      "packages/tui/src/virtual.spec.ts",
      "packages/agent-framework/src/session/offload.spec.ts",
    ],
  },
];

const metrics = {
  firstFrameMs: 0,
  effectMs: 0,
  reloadMs: 0,
  guardWaitMs: 0,
  longSessionMs: 0,
  memBytes: 0,
  tokenCost: 0,
};
const gates = [];

/** 首帧：真实子进程执行宿主发布二进制的 --version，取 3 次中位数。 */
const platform = process.platform;
const arch = process.arch;
const binaryName = platform === "win32" ? `zeta-${platform}-${arch}.exe` : `zeta-${platform}-${arch}`;
const binaryPath = join(root, "dist/local", `${platform}-${arch}`, binaryName);
const samples = [];
if (existsSync(binaryPath)) {
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const result = run(binaryPath, ["--version"]);
    const elapsed = performance.now() - started;
    if (result.code !== 0 || !result.stdout.includes("zeta 0.1.0")) {
      throw new Error(`FIRST_FRAME_BINARY_FAILED: ${result.code} ${result.out.slice(0, 200)}`);
    }
    samples.push(elapsed);
  }
} else {
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const result = run("bun", ["apps/zeta-cli/src/index.ts", "--version"]);
    const elapsed = performance.now() - started;
    if (result.code !== 0 || !result.stdout.includes("zeta 0.1.0")) {
      throw new Error(`FIRST_FRAME_SOURCE_FAILED: ${result.code} ${result.out.slice(0, 200)}`);
    }
    samples.push(elapsed);
  }
}
samples.sort((a, b) => a - b);
metrics.firstFrameMs = Math.round(samples[1]);
gates.push(
  makeGate({
    id: "perf-first-frame",
    category: "performance",
    name: "首帧：真实 --version 子进程三次中位数",
    status: "pass",
    detail: `${existsSync(binaryPath) ? "发布二进制" : "源码 CLI"} ${samples.map((v) => Math.round(v)).join("/")}ms，中位 ${metrics.firstFrameMs}ms`,
    evidence: [{ kind: "measurement", ref: "reports/gates-performance.json" }],
  })
);

for (const group of groups) {
  const gate = runTestGroup({
    id: group.id,
    name: group.name,
    category: "performance",
    files: group.files,
  });
  metrics[group.key] = gate.durationMs ?? 0;
  gates.push(gate);
}

/** 合成长会话基准：使用真实模块（VariableLayout/FiberSystem/BudgetTracker），非伪造数据。 */
const sampler = createMetricsSampler({ capacity: 4096 });
const layout = createVariableLayout(20_001, (index) => (index % 7) + 20);
let peakRss = process.memoryUsage().rss;
for (let index = 0; index < 2_000; index += 1) {
  const window = visibleWindow(layout.count, 40, index * 9);
  if (window.end > window.start) layout.offsetOf(window.start);
  sampler.sample();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
const fiberSystem = new FiberSystem();
for (let index = 0; index < 1_000; index += 1) {
  fiberSystem.create({ uid: `perf-${index}`, inject: [], provide: [key(`perf-service-${index}`)] });
  sampler.sample();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
metrics.memBytes = peakRss;

const tracker = createBudgetTracker({ totalContextLimit: 32_000, compactionThreshold: 24_000 });
let liveTokens = 0;
for (let index = 0; index < 800; index += 1) {
  const entry = { id: `msg-${index}`, role: index % 2 === 0 ? "user" : "assistant", text: "x".repeat(64 + (index % 32)) };
  // 与 offload.ts 的 defaultCountTokens 同算法：JSON 字节数 / 4 向上取整（显式标注为估算）。
  liveTokens += Math.ceil(JSON.stringify(entry).length / 4);
  tracker.observe(liveTokens);
}
metrics.tokenCost = tracker.peak;
const snapshot = sampler.snapshot();
writeJson("reports/perf-benchmark.json", {
  generatedAt: new Date().toISOString(),
  method: "合成长会话：真实 VariableLayout/FiberSystem/BudgetTracker；token 使用仓库同源的 JSON 字节数/4 估算器",
  metrics,
  samples,
  sampler: { capacity: sampler.capacity, samples: snapshot.samples, rssBytes: snapshot.rssBytes },
});

if (process.argv.includes("--emit-measurements")) {
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  process.exit(0);
}

const config = readConfig();
const checks = evaluatePerf(metrics, config.performance.budget);
for (const check of checks) {
  gates.push(
    makeGate({
      id: `perf-budget:${check.name}`,
      category: "performance",
      name: `性能预算 ${check.name}`,
      status: check.ok ? "pass" : "fail",
      detail: `实测 ${check.value} / 阈值 ${check.limit}${check.name === "tokenCost" ? "（token 为同源估算器结果）" : ""}`,
      evidence: [{ kind: "file", ref: "reports/perf-benchmark.json" }],
    })
  );
}

writeGates("performance", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
