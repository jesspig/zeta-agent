import { describe, expect, test } from "bun:test";
import { createAuditSink } from "@zeta-agent/security";
import {
  createEpisodeIdentity,
  createFrozenStore,
  type EpisodeIdentity,
} from "./frozen";
import {
  episodeEvidence,
  type EpisodeEvent,
  type EpisodeOutcome,
} from "./decision";
import {
  createSearchTestSplit,
  type FitnessTrace,
  type SearchTestSplit,
} from "./fitness";
import { isSealedPromotion } from "./seal";
import {
  assertPromotionInvariants,
  createPromotionState,
  promote,
  promoteWithDigest,
  promoteWithObservationEquivalence,
  replayPromotion,
  sha256Hex,
  type Candidate,
} from "./promotion";
import {
  bindPromotionAuthorization,
  consumePromotionAuthorization,
  issuePromotionSeal,
} from "./seal";
import {
  assertPipelineInvariants,
  CORE_INVARIANT_IDS,
  createPromotionPipeline,
  createRegressionGate,
  PROMOTION_STAGES,
  runCoreInvariants,
  type PromotionOutcome,
} from "./pipeline";

function identity(overrides: Partial<EpisodeIdentity> = {}): EpisodeIdentity {
  return createEpisodeIdentity({
    run: "run-1",
    task: "task-1",
    tenant: "tenant-a",
    domain: "coding",
    mode: "live",
    ...overrides,
  });
}

function outcome(cellId: string, score: number): EpisodeOutcome {
  return { cellId, score, valid: true, failed: false };
}

function events(): readonly EpisodeEvent[] {
  const id = identity();
  return [
    {
      identity: id,
      before: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      batch: [{ kind: "probe", cellId: "a" }, { kind: "probe", cellId: "b" }],
      parallelism: 2,
      outcomes: [outcome("a", 0.6), outcome("b", 0.4)],
      after: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    },
  ];
}

function fixture() {
  const id = identity();
  const store = createFrozenStore();
  const snapshot = store.freeze(id, episodeEvidence(events()));
  const split = createSearchTestSplit(["a", "b", "c", "d"], { salt: "s", holdout: 0.25 });
  const heldOutScores: Record<string, number> = {};
  for (const cellId of split.test) heldOutScores[cellId] = 0.9;
  for (const cellId of split.search) heldOutScores[cellId] = 0.1;
  const trace: FitnessTrace = {
    name: "t1",
    runBest: 1,
    nEvaluated: 2,
    points: [
      { budget: 1, best: 0.25, sequentialRounds: 1 },
      { budget: 3, best: 0.75, sequentialRounds: 2 },
    ],
  };
  const audit = createAuditSink();
  const seen: string[] = [];
  const gate = createRegressionGate({
    run: (invariantId) => {
      seen.push(invariantId);
      return true;
    },
  });
  const pipeline = createPromotionPipeline({
    identity: id,
    store,
    snapshot,
    regressionGate: gate,
    audit,
    heldOutThreshold: 0.5,
  });
  const request = {
    candidateId: "cand-1",
    artifact: "const next = 1 + 1;",
    expectedDigest: sha256Hex("const next = 1 + 1;"),
    events: events(),
    traces: [trace],
    heldOutScores,
    split,
    objectives: { reward: 0.9, heldOut: 0.9 },
    before: { mode: "base" },
    after: { mode: "base" },
    observationKeys: ["mode"],
    generation: 2,
  };
  return { id, store, snapshot, split, heldOutScores, audit, seen, gate, pipeline, request };
}

function incumbent(fitness: number): Candidate {
  const body = { id: "base", fitness, qualified: true, fingerprint: undefined };
  return {
    ...body,
    seal: issuePromotionSeal({ candidateId: "base", identityDigest: "identity-1", body }),
  };
}

describe("T-25 单一晋升 pipeline 强制全部门禁", () => {
  test("全部门禁通过才晋升，阶段顺序完整，incumbent 自动参赛", () => {
    const f = fixture();
    const pipeline = createPromotionPipeline({
      ...{ identity: f.id, store: f.store, snapshot: f.snapshot, regressionGate: f.gate },
      incumbent: incumbent(0.2),
      audit: f.audit,
      heldOutThreshold: 0.5,
    });

    const result = pipeline.run(f.request);
    expect(result.stages).toEqual([...PROMOTION_STAGES]);
    expect(result.decision.promoted).toBe(true);
    expect(result.state.incumbent?.id).toBe("cand-1");
    expect(result.state.incumbent?.fitness).toBeCloseTo(result.evaluation.reward);
    expect(isSealedPromotion(result.state.incumbent?.seal)).toBe(true);
    expect(result.ab.controlScore).toBe(0.2);
    expect(result.ab.treatmentScore).toBeCloseTo(result.evaluation.reward);
    expect(result.ab.eligible).toBe(true);
    expect(result.heldOut.score).toBeCloseTo(0.9);
    expect(result.replay.spent).toBe(result.replay.order.length);
    expect(f.seen).toHaveLength(24);
    expect(f.audit.entries.some((entry) => entry.record.decision === "RESEARCH_PROMOTION_COMMITTED")).toBe(true);
    expect(assertPromotionInvariants(result.state, [result.candidate])).toBe(true);
    expect(assertPipelineInvariants(result)).toBe(true);
  });

  test("无 incumbent 时首个合格候选直接晋升", () => {
    const f = fixture();
    const result = f.pipeline.run(f.request);
    expect(result.decision.promoted).toBe(true);
    expect(result.state.incumbent?.id).toBe("cand-1");
  });

  test("digest 不符：拒绝且不调用 evaluator", () => {
    const f = fixture();
    let evaluated = false;
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store: f.store,
      snapshot: f.snapshot,
      regressionGate: f.gate,
      evaluator: { evaluate: () => { evaluated = true; return { reward: 1, auc: 1, penalty: 0, scoredTraces: 1 }; } },
    });
    const result = pipeline.run({ ...f.request, expectedDigest: "0".repeat(64) });

    expect(result.decision.promoted).toBe(false);
    expect(result.decision.reason).toBe("digest-mismatch");
    expect(result.state.incumbent).toBeUndefined();
    expect(result.stages).toEqual(["digest"]);
    expect(evaluated).toBe(false);
  });
});

describe("T-25 pipeline 硬护栏失败即阻断", () => {
  test("重放预算恒等式被破坏时抛出预算错误", () => {
    const f = fixture();
    const tampered = events().map((event) => ({
      ...event,
      batch: [...event.batch, { kind: "probe" as const, cellId: "ghost" }],
    }));
    expect(() => f.pipeline.run({ ...f.request, events: tampered })).toThrow(/BUDGET/);
  });

  test("观察不等价时抛出且不产生任何晋升记录", () => {
    const f = fixture();
    expect(() =>
      f.pipeline.run({ ...f.request, after: { mode: "changed" } })
    ).toThrow(/OBSERVATION_EQUIVALENCE_MISMATCH/);
    expect(f.audit.entries.some((entry) => entry.record.decision === "RESEARCH_PROMOTION_COMMITTED")).toBe(false);
  });

  test("tripwire 命中 grader verdict 时抛出", () => {
    const f = fixture();
    const artifact = "const verdict = 1;";
    expect(() =>
      f.pipeline.run({ ...f.request, artifact, expectedDigest: sha256Hex(artifact) })
    ).toThrow(/LEAKAGE_TRIPWIRE/);
  });
});

describe("T-25 资格、Pareto、回归门与严格更优", () => {
  test("held-out 低于阈值拒绝", () => {
    const f = fixture();
    const scores = { ...f.heldOutScores };
    for (const cellId of f.split.test) scores[cellId] = 0.2;
    const result = f.pipeline.run({ ...f.request, heldOutScores: scores });
    expect(result.decision.reason).toBe("held-out-below-threshold");
    expect(result.state.incumbent).toBeUndefined();
  });

  test("Pareto 被 incumbent 支配时拒绝", () => {
    const f = fixture();
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store: f.store,
      snapshot: f.snapshot,
      regressionGate: f.gate,
      incumbent: incumbent(0.95),
      incumbentHeldOut: 0.95,
    });
    const result = pipeline.run({ ...f.request, objectives: { reward: 0.8, heldOut: 0.8 } });
    expect(result.decision.reason).toBe("pareto-dominated");
    expect(result.state.incumbent?.id).toBe("base");
  });

  test("回归门任一不变量失败即拒绝，24 条全部被检查", () => {
    const f = fixture();
    const seen: string[] = [];
    const gate = createRegressionGate({
      run: (id) => {
        seen.push(id);
        return id !== CORE_INVARIANT_IDS[7];
      },
    });
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store: f.store,
      snapshot: f.snapshot,
      regressionGate: gate,
    });
    const result = pipeline.run(f.request);
    expect(result.decision.reason).toBe("regression-failed");
    expect(seen).toHaveLength(24);
    expect(result.state.incumbent).toBeUndefined();
  });

  test("严格更优：更差或持平的候选不替换 incumbent", () => {
    const f = fixture();
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store: f.store,
      snapshot: f.snapshot,
      regressionGate: f.gate,
      incumbent: incumbent(0.99),
    });
    const result = pipeline.run({ ...f.request, objectives: { reward: 0.8, heldOut: 0.9 } });
    expect(result.decision.reason).toBe("not-strictly-better");
    expect(result.state.incumbent?.id).toBe("base");
  });

  test("篡改结果会被 assertPipelineInvariants 抓住", () => {
    const f = fixture();
    const result: PromotionOutcome = f.pipeline.run(f.request);
    const forged: PromotionOutcome = {
      ...result,
      decision: { ...result.decision, promoted: false },
    };
    expect(() => assertPipelineInvariants(forged)).toThrow(/PIPELINE_INVARIANT/);
  });
});

describe("T-25 绕过默认 promote / evaluator 必须失败", () => {
  test("裸 Candidate 与伪造 seal 都不能调用 promote 及其变体", () => {
    const state = createPromotionState();
    const bare: Candidate = { id: "x", fitness: 0.9, qualified: true } as Candidate;
    expect(() => promote(state, bare)).toThrow(/PROMOTION_SEAL_REQUIRED/);
    expect(() => promote(state, { ...bare, seal: { kind: "promotion" } } as unknown as Candidate)).toThrow(
      /PROMOTION_SEAL_REQUIRED/
    );
    expect(() =>
      promoteWithDigest(state, bare, { artifact: "x", expectedDigest: sha256Hex("x") })
    ).toThrow(/PROMOTION_SEAL_REQUIRED/);
    expect(() =>
      promoteWithObservationEquivalence(state, bare, {
        before: {},
        after: {},
      })
    ).toThrow(/PROMOTION_SEAL_REQUIRED/);
    expect(() => replayPromotion([bare])).toThrow(/PROMOTION_SEAL_REQUIRED/);
    expect(state.history).toHaveLength(0);
  });

  test("复制已签发 seal 篡改 fitness 仍被拒绝", () => {
    const f = fixture();
    const committed = f.pipeline.run(f.request).candidate;
    const forged = { ...committed, fitness: 999 };
    expect(() => promote(createPromotionState(), forged)).toThrow(/PROMOTION_SEAL_BODY_MISMATCH/);
    expect(() => promote(createPromotionState(), { ...committed, qualified: true })).toThrow(
      /PROMOTION_AUTHORIZATION_CONSUMED/
    );
  });
});

describe("T-21 一次性晋升授权与真实回归", () => {
  test("pipeline 消费授权后裸 promote/replayPromotion 拒绝复用 seal", () => {
    const f = fixture();
    const committed = f.pipeline.run(f.request).candidate;
    expect(() => promote(createPromotionState(), committed)).toThrow(
      /PROMOTION_AUTHORIZATION_CONSUMED/
    );
    expect(() => replayPromotion([committed])).toThrow(/PROMOTION_AUTHORIZATION_CONSUMED/);
    expect(() =>
      promoteWithDigest(createPromotionState(), committed, {
        artifact: "x",
        expectedDigest: sha256Hex("x"),
      })
    ).toThrow(/PROMOTION_AUTHORIZATION_CONSUMED/);
  });

  test("授权绑定 candidate/artifact/snapshot/identity/nonce，错绑定与二次消费均拒绝", () => {
    const body = {
      id: "cand-1",
      fitness: 0.5,
      qualified: true,
      fingerprint: undefined,
    };
    const seal = issuePromotionSeal({ candidateId: "cand-1", identityDigest: "id", body });
    const candidate: Candidate = { ...body, seal };
    const binding = {
      candidateId: "cand-1",
      artifactDigest: "a".repeat(64),
      snapshotDigest: "s".repeat(64),
      identityDigest: "id",
      nonce: "n-1",
    };
    expect(bindPromotionAuthorization(seal, binding)).toBe(true);
    expect(() => consumePromotionAuthorization(seal, { ...binding, nonce: "n-2" })).toThrow(
      /BINDING_MISMATCH/
    );
    expect(consumePromotionAuthorization(seal, binding)).toBe(true);
    expect(() => consumePromotionAuthorization(seal, binding)).toThrow(/CONSUMED/);
    expect(() => promote(createPromotionState(), candidate)).toThrow(/CONSUMED/);
  });

  test("24 条不变量真实执行；failed replay 与空 episode 均被拒绝", () => {
    const f = fixture();
    const result = f.pipeline.run(f.request);
    expect(result.regression.results).toHaveLength(24);
    expect(result.regression.passed).toBe(true);
    const context = {
      candidateId: f.request.candidateId,
      events: f.request.events,
      replay: result.replay,
      evaluation: result.evaluation,
      heldOut: result.heldOut,
      ab: result.ab,
      snapshotDigest: f.snapshot.manifest.digest,
    };
    expect(runCoreInvariants(context).passed).toBe(true);
    expect(runCoreInvariants({ ...context, replay: { ...result.replay, failed: ["a"] } }).passed).toBe(
      false
    );
    expect(runCoreInvariants({ ...context, events: [] }).passed).toBe(false);
  });

  test("宿主注入恒真 gate 不能让空 episode 通过真实回归", () => {
    const f = fixture();
    const store = createFrozenStore();
    const snapshot = store.freeze(f.id, episodeEvidence([]));
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store,
      snapshot,
      regressionGate: createRegressionGate({ run: () => true }),
      heldOutThreshold: 0.5,
    });
    const result = pipeline.run({ ...f.request, events: [] });
    expect(result.decision.reason).toBe("regression-failed");
    expect(result.regression.failedIds.length).toBeGreaterThan(0);
    expect(result.stages).toEqual([...PROMOTION_STAGES.slice(0, 6)]);
  });

  test("failed replay 的真实反例被回归门拦下", () => {
    const f = fixture();
    const failedEvents = f.request.events.map((event) => ({
      ...event,
      outcomes: event.outcomes.map((outcome, index) =>
        index === 0 ? { ...outcome, failed: true } : outcome
      ),
    }));
    const store = createFrozenStore();
    const snapshot = store.freeze(f.id, episodeEvidence(failedEvents));
    const pipeline = createPromotionPipeline({
      identity: f.id,
      store,
      snapshot,
      regressionGate: createRegressionGate({ run: () => true }),
      heldOutThreshold: 0.5,
    });
    const result = pipeline.run({ ...f.request, events: failedEvents });
    expect(result.decision.reason).toBe("regression-failed");
    expect(result.regression.failedIds).toContain(CORE_INVARIANT_IDS[10]!);
  });

  test("held-out 在 search 前沿之后只评一次", () => {
    const f = fixture();
    const result = f.pipeline.run(f.request);
    expect(result.frontier).toContain(f.request.candidateId);
    expect(result.heldOutEvaluations).toBe(1);
    expect(result.nonce.length).toBeGreaterThan(0);
  });
});
