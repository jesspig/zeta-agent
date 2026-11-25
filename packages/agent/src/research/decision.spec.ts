import { describe, expect, test } from "bun:test";
import { createAuditSink } from "@zeta-agent/security";
import {
  createEpisodeIdentity,
  createFrozenStore,
  createMemoryEvidenceFiles,
  identityDigest,
  type EpisodeIdentity,
} from "./frozen";
import {
  assertActionLegal,
  assertPermission,
  assertProbeViewNoScore,
  assertReplayInvariants,
  createLiveSurface,
  createProposerSurface,
  createReplaySurface,
  createScopedSurface,
  episodeEvidence,
  isActionLegal,
  readEpisodeLog,
  replayEpisode,
  runPolicy,
  type ActionState,
  type CellMeta,
  type DecisionAction,
  type EpisodeEvent,
  type EpisodeOutcome,
  type ProbeView,
} from "./decision";

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

function cells(): readonly CellMeta[] {
  return [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];
}

function outcome(cellId: string, score: number, failed = false): EpisodeOutcome {
  return { cellId, score, valid: !failed, ...(failed ? { failClass: "crash" } : {}), failed };
}

function event(overrides: Partial<EpisodeEvent> = {}): EpisodeEvent {
  return {
    identity: identity(),
    before: cells(),
    batch: [
      { kind: "probe", cellId: "a" },
      { kind: "probe", cellId: "b" },
    ],
    parallelism: 2,
    outcomes: [outcome("a", 0.6), outcome("b", 0.4)],
    after: cells(),
    ...overrides,
  };
}

function events(): readonly EpisodeEvent[] {
  return [event(), event({
    batch: [{ kind: "probe", cellId: "c" }],
    parallelism: 1,
    outcomes: [outcome("c", 0.7)],
  })];
}

function frozen(sequence = events()) {
  const store = createFrozenStore({ files: createMemoryEvidenceFiles() });
  const snapshot = store.freeze(identity(), episodeEvidence(sequence));
  return { store, snapshot, sequence };
}

describe("T-24 统一 action legal 检查", () => {
  test("预算耗尽、未知 cell、重复评估与未知动作全部非法", () => {
    const state: ActionState = { budget: 2, spent: 0, cells: cells(), evaluated: [] };
    expect(isActionLegal(state, { kind: "probe", cellId: "a" })).toBe(true);
    expect(isActionLegal(state, { kind: "step", cellId: "b" })).toBe(true);
    expect(isActionLegal(state, { kind: "control", action: "abort" })).toBe(true);
    expect(isActionLegal(state, { kind: "probe", cellId: "missing" })).toBe(false);
    expect(isActionLegal({ ...state, spent: 2 }, { kind: "probe", cellId: "a" })).toBe(false);
    expect(isActionLegal({ ...state, evaluated: ["a"] }, { kind: "probe", cellId: "a" })).toBe(false);
    expect(isActionLegal(state, { kind: "unknown", cellId: "a" } as unknown as DecisionAction)).toBe(false);
    expect(() => assertActionLegal(state, { kind: "probe", cellId: "missing" })).toThrow(/ILLEGAL_ACTION/);
    expect(assertActionLegal(state, { kind: "probe", cellId: "a" })).toBe(true);
  });

  test("live/replay 两个 surface 对同一动作给出相同合法性判定", () => {
    const { store, snapshot, sequence } = frozen();
    const live = createLiveSurface({
      identity: identity(),
      budget: 3,
      cells: cells(),
      probe: (cellId) => ({ score: 0.5, valid: true }),
    });
    const replay = createReplaySurface({ identity: identity(), store, snapshot });
    expect(readEpisodeLog(snapshot)).toEqual(sequence);

    const actions: readonly DecisionAction[] = [
      { kind: "probe", cellId: "a" },
      { kind: "probe", cellId: "missing" },
      { kind: "control", action: "reset" },
    ];
    for (const action of actions) {
      expect(replay.legal(action)).toBe(live.legal(action));
    }
  });
});

describe("T-24 live / replay DecisionSurface 对偶", () => {
  test("相同策略在 live 与 replay 上得到相同 order/budget/best", () => {
    const sequence = events();
    const { store, snapshot } = frozen(sequence);
    const scores = new Map(sequence.flatMap((item) => item.outcomes).map((item) => [item.cellId, item.score]));
    const live = createLiveSurface({
      identity: identity(),
      budget: 3,
      cells: cells(),
      probe: (cellId) => ({ score: scores.get(cellId)!, valid: true }),
    });
    const replay = createReplaySurface({ identity: identity(), store, snapshot });
    const actions: readonly DecisionAction[] = [
      { kind: "probe", cellId: "a" },
      { kind: "probe", cellId: "b" },
      { kind: "probe", cellId: "c" },
    ];

    const liveResult = runPolicy(live, actions);
    const replayResult = runPolicy(replay, actions);
    expect(liveResult.mode).toBe("live");
    expect(replayResult.mode).toBe("replay");
    expect(replayResult.order).toEqual(liveResult.order);
    expect(replayResult.spent).toBe(liveResult.spent);
    expect(replayResult.best).toBe(liveResult.best);
    expect(replayResult.observations.map((item) => item.score)).toEqual(
      liveResult.observations.map((item) => item.score)
    );
  });

  test("replay 身份/摘要不匹配与冻结前缀外探测均抛错", () => {
    const { store, snapshot } = frozen();
    expect(() =>
      createReplaySurface({ identity: identity({ tenant: "tenant-b" }), store, snapshot })
    ).toThrow(/IDENTITY/);
    expect(() =>
      createReplaySurface({ identity: identity({ mode: "replay" }), store, snapshot })
    ).toThrow(/IDENTITY/);
    expect(() =>
      createReplaySurface({ identity: identity(), store, snapshot, expectedDigest: "0".repeat(64) })
    ).toThrow(/DIGEST/);

    const replay = createReplaySurface({ identity: identity(), store, snapshot });
    expect(() => replay.probe("outside")).toThrow(/PREFIX/);
  });
});

describe("T-24 replayEpisode 冻结前缀重放不变量", () => {
  test("按冻结顺序执行并记录 budget/order/best，所有不变量成立", () => {
    const { store, snapshot, sequence } = frozen();
    const result = replayEpisode(sequence, {
      identity: identity(),
      store,
      expectedDigest: snapshot.manifest.digest,
    });

    expect(result.mode).toBe("replay");
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.spent).toBe(3);
    expect(result.budget).toBe(3);
    expect(result.best).toBe(0.7);
    expect(result.runBest).toBe(0.7);
    expect(result.legal.every(Boolean)).toBe(true);
    expect(assertReplayInvariants(result)).toBe(true);
  });

  test("incumbent 抬高 runBest，best ≤ runBest 是真实不变量", () => {
    const { store, snapshot, sequence } = frozen();
    const result = replayEpisode(sequence, {
      identity: identity(),
      store,
      expectedDigest: snapshot.manifest.digest,
      incumbentScore: 0.9,
    });
    expect(result.best).toBe(0.7);
    expect(result.runBest).toBe(0.9);
    expect(assertReplayInvariants(result)).toBe(true);
    expect(() => assertReplayInvariants({ ...result, best: 0.95 })).toThrow(/RUNBEST/);
  });

  test("失败尝试记 0 且仍占预算，不因跳过而虚假节省", () => {
    const sequence = [
      event({
        batch: [
          { kind: "probe", cellId: "a" },
          { kind: "probe", cellId: "b" },
          { kind: "probe", cellId: "c" },
        ],
        parallelism: 3,
        outcomes: [outcome("a", 0.6), outcome("b", 0.95, true), outcome("c", 0.8)],
      }),
    ];
    const { store, snapshot } = frozen(sequence);
    const result = replayEpisode(sequence, { identity: identity(), store, expectedDigest: snapshot.manifest.digest });

    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.spent).toBe(3);
    expect(result.failed).toEqual(["b"]);
    expect(result.observations.find((item) => item.cellId === "b")?.score).toBe(0);
    expect(result.best).toBe(0.8);
    expect(assertReplayInvariants(result)).toBe(true);
  });

  test("重复评估与非法并行度在重放前即抛错", () => {
    const sequence = [event({
      batch: [
        { kind: "probe", cellId: "a" },
        { kind: "probe", cellId: "a" },
      ],
      parallelism: 2,
      outcomes: [outcome("a", 0.6), outcome("a", 0.7)],
    })];
    const { store } = frozen(sequence);
    expect(() => replayEpisode(sequence, { identity: identity(), store })).toThrow(/ILLEGAL_ACTION|PREFIX/);

    const badParallel = [event({ parallelism: 3 })];
    const second = frozen(badParallel);
    expect(() => replayEpisode(badParallel, { identity: identity(), store: second.store })).toThrow(/PARALLELISM/);
  });

  test("事件流与冻结快照不一致时拒绝重放", () => {
    const { store, snapshot } = frozen();
    const tampered = [event({ batch: [{ kind: "probe", cellId: "c" }], outcomes: [outcome("c", 0.9)] })];
    expect(() => replayEpisode(tampered, { identity: identity(), store, expectedDigest: snapshot.manifest.digest })).toThrow(
      /PREFIX|DIGEST/
    );
  });
});

describe("T-24 trace / score / verdict 权限分层", () => {
  test("proposer 只读 ProbeView，score 可读分数，verdict 可读裁决", () => {
    const audit = createAuditSink();
    const { store } = frozen();
    const surface = createReplaySurface({ identity: identity(), store, audit });
    const proposer = createProposerSurface(surface, { audit });

    const view: ProbeView = proposer.probe("a");
    expect(view.ok).toBe(true);
    expect(view.delivered).toBe(true);
    expect(assertProbeViewNoScore(view)).toBe(true);
    expect(() => proposer.observe("a")).toThrow(/PERMISSION/);
    expect(() => proposer.verdict("a")).toThrow(/PERMISSION/);

    const scorer = createScopedSurface(surface, "score", { audit });
    expect(scorer.observe("a").score).toBe(0.6);
    expect(() => scorer.verdict("a")).toThrow(/PERMISSION/);

    const judge = createScopedSurface(surface, "verdict", { audit });
    expect(judge.verdict("a").cellId).toBe("a");
    expect(audit.entries.some((entry) => entry.record.decision === "RESEARCH_SCORE_READ" && entry.record.tenant === "tenant-a")).toBe(true);
    expect(audit.entries.some((entry) => entry.record.decision === "RESEARCH_VERDICT_READ" && entry.record.tenant === "tenant-a")).toBe(true);
  });

  test("权限等级不足直接在 assertPermission 抛错", () => {
    expect(assertPermission("trace", "trace")).toBe(true);
    expect(assertPermission("verdict", "score")).toBe(true);
    expect(() => assertPermission("trace", "score")).toThrow(/PERMISSION/);
    expect(() => assertPermission("score", "verdict")).toThrow(/PERMISSION/);
    expect(() => assertProbeViewNoScore({ ...({} as ProbeView), score: 0.9 } as ProbeView)).toThrow(/LEAK/);
  });

  test("身份摘要参与审计的 argsDigest，避免跨身份混用视图", () => {
    expect(identityDigest(identity())).toHaveLength(64);
  });
});
