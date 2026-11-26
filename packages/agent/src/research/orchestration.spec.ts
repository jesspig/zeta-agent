import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperienceStore } from "./experience";
import {
  createFileEvidenceFiles,
  createFileFrozenPersistence,
  createFrozenStore,
} from "./frozen";
import { createRegressionGate, PROMOTION_STAGES } from "./pipeline";
import {
  assertResearchNotInDefaultAssembly,
  createEditableSurface,
  createResumeController,
  createStrategyPlugin,
  resolveResearchEnablement,
  runResearchLoop,
} from "./orchestration";
import { createFilePromotionSealRegistry } from "./seal-registry";

const identity = {
  run: "research-run",
  task: "research-task",
  tenant: "tenant-r",
  domain: "coding",
  mode: "live" as const,
};

function regressionGate() {
  return createRegressionGate({ run: () => true });
}

function strategy() {
  return createStrategyPlugin({
    name: "strategy:real",
    propose: ({ round, surface, earlier }) => ({
      id: `cand-${round}`,
      artifact: `const next = ${round} + ${earlier.length}; // rev ${surface.revision}\n`,
      rationale: `round ${round} learned from ${earlier.length} earlier entries`,
    }),
  });
}

function evaluator() {
  return {
    evaluate: ({ candidateId }: { candidateId: string }) => ({
      reward: candidateId === "cand-1" ? 0.9 : 0.95,
      auc: 1,
      penalty: 0,
      scoredTraces: 1,
    }),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zeta-research-loop-"));
  const store = createFrozenStore({
    files: createFileEvidenceFiles(join(root, "files")),
    persistence: createFileFrozenPersistence(join(root, "manifest")),
  });
  return {
    root,
    store,
    experienceStore: createExperienceStore(),
    surface: createEditableSurface("const target = 1; // @VERSION@\n"),
  };
}

describe("T-22 ResearchProfile 默认禁用与显式启用", () => {
  test("默认装配不含研究 seam；研究 profile 也要求显式 opt-in", () => {
    expect(assertResearchNotInDefaultAssembly()).toBe(true);
    expect(resolveResearchEnablement({}).enabled).toBe(false);
    expect(resolveResearchEnablement({ profile: "research" }).reason).toBe(
      "RESEARCH_REQUIRES_EXPLICIT_OPT_IN"
    );
    expect(resolveResearchEnablement({ profile: "research", enableResearch: true }).enabled).toBe(true);
  });

  test("未显式启用时 runResearchLoop 拒绝进入编排", () => {
    const f = setup();
    try {
      expect(() =>
        runResearchLoop({
          runId: "blocked",
          identity,
          store: f.store,
          experienceStore: f.experienceStore,
          surface: f.surface,
          strategy: strategy(),
          regressionGate: regressionGate(),
          rounds: 2,
        })
      ).toThrow(/RESEARCH_DISABLED/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("T-22 跨进程 RESUME seal 绑定", () => {
  function registryPath(root: string): string {
    return join(root, "seals.json");
  }

  test("持久化 seal 注册后跨进程 RESUME 可继续；伪造注册表被拒绝", async () => {
    const f = setup();
    try {
      const sealRegistry = createFilePromotionSealRegistry(registryPath(f.root));
      const first = runResearchLoop({
        runId: "sealed-resume",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: f.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 1,
        sealRegistry,
      });
      const reopened = createFilePromotionSealRegistry(registryPath(f.root));
      const second = runResearchLoop({
        runId: "sealed-resume",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: first.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
        resume: first.resume,
        sealRegistry: reopened,
      });
      expect(second.rounds).toHaveLength(1);
      expect(second.rounds[0]!.round).toBe(2);

      const empty = createFilePromotionSealRegistry(join(f.root, "empty-seals.json"));
      expect(() => runResearchLoop({
        runId: "sealed-resume",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: first.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
        resume: first.resume,
        sealRegistry: empty,
      })).toThrow(/RESUME_SEAL_NOT_REGISTERED/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("旧 runId 与不同身份的 checkpoint 均被拒绝", () => {
    const f = setup();
    try {
      const first = runResearchLoop({
        runId: "identity-run",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: f.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 1,
      });
      expect(() => runResearchLoop({
        runId: "different-run",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: first.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
        resume: first.resume,
      })).toThrow(/RESUME_RUN_MISMATCH/);
      expect(() => runResearchLoop({
        runId: "identity-run",
        enableResearch: true,
        identity: { ...identity, tenant: "other-tenant" },
        store: f.store,
        experienceStore: f.experienceStore,
        surface: first.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
        resume: first.resume,
      })).toThrow(/RESUME_IDENTITY_MISMATCH/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("T-22 两轮真实候选 E2E 闭环", () => {
  test("显式启用后两轮候选都走完整 FrozenStore + PromotionPipeline，earlier-only 生效", () => {
    const f = setup();
    try {
      const run = runResearchLoop({
        runId: "e2e",
        profile: "research",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: f.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
      });

      expect(run.enabled).toBe(true);
      expect(run.rounds).toHaveLength(2);
      expect(run.rounds.map((round) => round.candidateId)).toEqual(["cand-1", "cand-2"]);
      expect(run.rounds[0]!.earlierIds).toEqual([]);
      expect(run.rounds[1]!.earlierIds).toEqual(["research:e2e:1"]);
      expect(run.rounds.every((round) => round.promoted)).toBe(true);
      for (const round of run.rounds) {
        expect(round.stages).toEqual([...PROMOTION_STAGES]);
        expect(round.snapshot.manifest.digest).toBe(round.frozenDigest);
        expect(round.outcome.regression.passed).toBe(true);
        expect(round.outcome.replay.spent).toBe(round.outcome.replay.order.length);
        expect(f.store.get(round.frozenDigest, round.candidateId)).toBeDefined();
      }
      expect(run.rounds[0]!.frozenDigest).not.toBe(run.rounds[1]!.frozenDigest);
      expect(run.surface.revision).toBe(3);
      expect(run.surface.content).toContain("cand-1");
      expect(run.surface.content).toContain("cand-2");
      expect(run.incumbent?.id).toBe("cand-2");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("RESUME：检查点摘要校验，重启 store 后从下一轮继续且已完成轮次不重复", () => {
    const f = setup();
    try {
      const first = runResearchLoop({
        runId: "resume",
        enableResearch: true,
        identity,
        store: f.store,
        experienceStore: f.experienceStore,
        surface: f.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 1,
      });
      const controller = createResumeController();
      const checkpoint = controller.resume(first.resume);

      const restartedStore = createFrozenStore({
        files: createFileEvidenceFiles(join(f.root, "files")),
        persistence: createFileFrozenPersistence(join(f.root, "manifest")),
      });
      const second = runResearchLoop({
        runId: "resume",
        enableResearch: true,
        identity,
        store: restartedStore,
        experienceStore: f.experienceStore,
        surface: first.surface,
        strategy: strategy(),
        regressionGate: regressionGate(),
        evaluator: evaluator(),
        rounds: 2,
        resume: checkpoint,
      });

      expect(second.rounds).toHaveLength(1);
      expect(second.rounds[0]!.round).toBe(2);
      expect(second.rounds[0]!.earlierIds).toEqual(["research:resume:1"]);
      expect(restartedStore.get(first.rounds[0]!.frozenDigest, "cand-1")).toBeDefined();
      expect(() => controller.resume({ ...checkpoint, completedRounds: 99 })).toThrow(
        /RESUME_DIGEST_MISMATCH/
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
