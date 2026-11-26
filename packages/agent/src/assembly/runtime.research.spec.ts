import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperienceStore } from "../research/experience";
import { createFileEvidenceFiles, createFileFrozenPersistence, createFrozenStore } from "../research/frozen";
import { createRegressionGate } from "../research/pipeline";
import { createEditableSurface, createStrategyPlugin } from "../research/orchestration";
import { createDefaultRuntime } from "./runtime";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-runtime-research-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function researchConfig(root: string) {
  return {
    runId: "runtime-research",
    identity: {
      run: "runtime-research",
      task: "runtime-task",
      tenant: "tenant-r",
      domain: "coding",
      mode: "live" as const,
    },
    store: createFrozenStore({
      files: createFileEvidenceFiles(join(root, "files")),
      persistence: createFileFrozenPersistence(join(root, "manifest")),
    }),
    experienceStore: createExperienceStore(),
    surface: createEditableSurface("const target = 1; // @VERSION@\n"),
    strategy: createStrategyPlugin({
      name: "strategy:runtime",
      propose: ({ round }) => ({ id: `cand-${round}`, artifact: `const next = ${round};\n`, rationale: "runtime" }),
    }),
    regressionGate: createRegressionGate({ run: () => true }),
    evaluator: {
      evaluate: ({ candidateId }: { candidateId: string }) => ({
        reward: candidateId === "cand-1" ? 0.9 : 0.95,
        auc: 1,
        penalty: 0,
        scoredTraces: 1,
      }),
    },
    rounds: 2,
  };
}

describe("T-25 research profile 生产入口", () => {
  test("未配置研究编排时失败关闭，能力诊断不伪装 unsupported", async () => {
    const root = tempRoot();
    const runtime = await createDefaultRuntime({
      profile: "research",
      includeBuiltins: false,
      agentRoot: join(root, "agent"),
      sessionStorePath: join(root, "session.jsonl"),
    });

    expect(() => runtime.runResearch()).toThrow("RESEARCH_CONFIG_REQUIRED");
    expect(runtime.manifest.diagnostics.find((item) => item.id === "research:seal")?.state).toBe("active");
    await runtime.dispose();
  });

  test("显式配置经 runtime.runResearch 执行完整两轮闭环", async () => {
    const root = tempRoot();
    const runtime = await createDefaultRuntime({
      profile: "research",
      includeBuiltins: false,
      agentRoot: join(root, "agent"),
      sessionStorePath: join(root, "session.jsonl"),
      research: researchConfig(root),
    });

    const run = runtime.runResearch();

    expect(run.enabled).toBe(true);
    expect(run.rounds.map((round) => round.candidateId)).toEqual(["cand-1", "cand-2"]);
    expect(run.rounds.every((round) => round.promoted)).toBe(true);
    await runtime.dispose();
  });
});
