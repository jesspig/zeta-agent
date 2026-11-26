/**
 * RED-16（T-22，本地 fixture，不访问外网）：
 * OTLP/HTTP 真实 wire 可达；FrozenStore 重启恢复；研究默认禁用且显式启用后两轮真实候选闭环。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = [];
const evidence = [];

function fail(message) {
  failures.push(message);
}

async function probeOtlpWire() {
  let resolveCaptured;
  const captured = new Promise((resolve) => {
    resolveCaptured = resolve;
  });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      resolveCaptured({
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { createOtlpHttpExporter } = await import(
      "../../packages/components/observability/src/index.ts"
    );
    const exporter = createOtlpHttpExporter({ endpoint: `http://127.0.0.1:${server.port}/v1/logs` });
    exporter.export({ fiberUid: "red16", runId: "red16", level: "info", message: "RED16_WIRE_OK" });
    const wire = await captured;
    if (wire.method !== "POST" || wire.path !== "/v1/logs") {
      fail(`otlp-wire method/path=${wire.method}:${wire.path}`);
      return;
    }
    if (wire.contentType !== "application/json") fail(`otlp-wire content-type=${wire.contentType}`);
    const payload = JSON.parse(wire.body);
    const record = payload.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0];
    if (record?.body?.stringValue !== "RED16_WIRE_OK") {
      fail(`otlp-wire body=${JSON.stringify(record)}`);
      return;
    }
    evidence.push(`otlp-wire ${wire.method} ${wire.path} bytes=${wire.body.length}`);
  } finally {
    server.stop(true);
  }
}

async function probeEvidenceRestart() {
  const root = mkdtempSync(join(tmpdir(), "zeta-red16-"));
  try {
    const frozen = await import("../../packages/agent/src/research/frozen.ts");
    const store = frozen.createFrozenStore({
      files: frozen.createFileEvidenceFiles(join(root, "files")),
      persistence: frozen.createFileFrozenPersistence(join(root, "manifest")),
    });
    const identity = frozen.createEpisodeIdentity({
      run: "red16", task: "red16", tenant: "tenant-r16", domain: "coding", mode: "live",
      candidate: "cand-red16",
    });
    const snapshot = store.freeze(identity, { "rollout.md": "RED16_FULL_TRACE\n".repeat(20) });
    const restored = frozen.createFrozenStore({
      files: frozen.createFileEvidenceFiles(join(root, "files")),
      persistence: frozen.createFileFrozenPersistence(join(root, "manifest")),
    });
    const recovered = restored.get(snapshot.manifest.digest, "cand-red16");
    if (recovered?.evidence["rollout.md"] !== snapshot.evidence["rollout.md"]) {
      fail("evidence-store-restart: 证据未恢复或全文被截断");
      return;
    }
    evidence.push(`evidence-restart digest=${snapshot.manifest.digest.slice(0, 12)} bytes=${snapshot.evidence["rollout.md"].length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function probeResearchOrchestration() {
  const { createExperienceStore } = await import("../../packages/agent/src/research/experience.ts");
  const { createFrozenStore } = await import("../../packages/agent/src/research/frozen.ts");
  const { createRegressionGate, PROMOTION_STAGES } = await import("../../packages/agent/src/research/pipeline.ts");
  const {
    assertResearchNotInDefaultAssembly,
    createEditableSurface,
    createStrategyPlugin,
    resolveResearchEnablement,
    runResearchLoop,
  } = await import("../../packages/agent/src/research/orchestration.ts");

  if (!assertResearchNotInDefaultAssembly() || resolveResearchEnablement({ profile: "research" }).enabled) {
    fail("research-default: 研究轨未默认禁用");
  }
  const identity = {
    run: "red16-research", task: "red16", tenant: "tenant-r16", domain: "coding", mode: "live",
  };
  const options = {
    runId: "red16-research",
    enableResearch: true,
    identity,
    store: createFrozenStore(),
    experienceStore: createExperienceStore(),
    surface: createEditableSurface("const target = 1; // @VERSION@\n"),
    strategy: createStrategyPlugin({
      name: "strategy:red16",
      propose: ({ round, earlier }) => ({
        id: `cand-${round}`,
        artifact: `const next = ${round} + ${earlier.length};\n`,
        rationale: `round ${round} from ${earlier.length} earlier entries`,
      }),
    }),
    regressionGate: createRegressionGate({ run: () => true }),
    evaluator: {
      evaluate: ({ candidateId }) => ({
        reward: candidateId === "cand-1" ? 0.9 : 0.95,
        auc: 1, penalty: 0, scoredTraces: 1,
      }),
    },
    rounds: 2,
  };
  let run;
  try {
    run = runResearchLoop(options);
  } catch (error) {
    fail(`research-orchestration: ${error.message}`);
    return;
  }
  if (run.rounds.length !== 2) fail(`research-rounds=${run.rounds.length}`);
  if (!run.rounds.every((round) => round.stages.join("|") === PROMOTION_STAGES.join("|"))) {
    fail("research-orchestration: 存在未走完整管线的 seam 轮次");
  }
  if (run.rounds[0].frozenDigest === run.rounds[1].frozenDigest) {
    fail("research-orchestration: 两轮候选产生相同冻结摘要");
  }
  if (run.rounds[1].earlierIds.length !== 1) fail("research-orchestration: earlier-only 未生效");
  evidence.push(`research-rounds=${run.rounds.length} promoted=${run.rounds.map((r) => r.promoted).join(",")}`);
}

async function probe() {
  await probeOtlpWire();
  await probeEvidenceRestart();
  await probeResearchOrchestration();
  return {
    green: failures.length === 0,
    actual: failures.length === 0 ? "OTLP 真实 wire / 证据重启恢复 / 两轮真实研究闭环全部通过" : failures,
    reason: failures.length === 0 ? "T-22 无 seam、无内存丢失、无默认启用" : "存在 T-22 实现缺口",
    evidence: evidence.join(" | "),
  };
}

export default {
  id: "RED-16",
  expectation:
    "OTLP/HTTP 真实 wire 字节可达；FrozenStore 重启恢复完整证据；研究默认禁用，显式启用后至少两轮真实候选闭环（非组件测试替代）",
  probe,
};
