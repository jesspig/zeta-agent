import { randomBytes } from "node:crypto";
import type { AuditSink } from "@zeta-agent/security";
import {
  assertReplayInvariants,
  replayEpisode,
  type EpisodeEvent,
  type ReplayResult,
} from "./decision";
import { assertNoGraderVerdicts } from "./experience";
import {
  assertSearchTestIsolation,
  compareAB,
  createABHarness,
  createFitnessEvaluator,
  dominates,
  paretoFrontier,
  scoreHeldOut,
  type ABComparison,
  type FitnessEvaluation,
  type FitnessEvaluator,
  type FitnessTrace,
  type ObjectiveVector,
  type SearchTestSplit,
} from "./fitness";
import {
  identityDigest,
  type EpisodeIdentity,
  type FrozenSnapshot,
  type FrozenStore,
} from "./frozen";
import {
  assertObservationEquivalence,
  createPromotionState,
  matchesArtifactDigest,
  promote,
  recordPromotionRejection,
  sha256Hex,
  type Candidate,
  type PromotionArtifact,
  type PromotionRejectionReason,
  type PromotionState,
} from "./promotion";
import {
  bindPromotionAuthorization,
  consumePromotionAuthorization,
  issueEvaluatorSeal,
  issuePromotionSeal,
  isSealedPromotion,
  type PromotionAuthorizationBinding,
} from "./seal";

export type PromotionStage =
  | "digest"
  | "budget"
  | "observation"
  | "tripwire"
  | "eligibility"
  | "regression"
  | "compare"
  | "commit";

/** 唯一晋升路径的固定阶段顺序，任何阶段都不可跳过。 */
export const PROMOTION_STAGES: readonly PromotionStage[] = Object.freeze([
  "digest",
  "budget",
  "observation",
  "tripwire",
  "eligibility",
  "regression",
  "compare",
  "commit",
]);

export const CORE_INVARIANT_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return [`inv-core-${number}-legacy`, `inv-core-${number}-plugin`];
  }).reduce<string[]>((all, pair) => [...all, ...pair], [])
);

export interface RegressionReport {
  readonly passed: boolean;
  readonly results: readonly { readonly id: string; readonly passed: boolean }[];
  readonly failedIds: readonly string[];
  readonly missingIds: readonly string[];
}

export interface RegressionGate {
  verify(candidateId: string): RegressionReport;
}

export interface RegressionGateOptions {
  readonly run: (invariantId: string, candidateId: string) => boolean;
}

/** 候选回归门：24 条不变量（12 条 × legacy/plugin）逐条执行，缺项按失败处理。 */
export function createRegressionGate(options: RegressionGateOptions): RegressionGate {
  if (typeof options.run !== "function") throw new Error("INVALID_REGRESSION_RUNNER");
  return {
    verify(candidateId) {
      if (typeof candidateId !== "string" || candidateId.length === 0) {
        throw new Error("INVALID_REGRESSION_CANDIDATE");
      }
      const results: { id: string; passed: boolean }[] = [];
      const failedIds: string[] = [];
      const missingIds: string[] = [];
      for (const id of CORE_INVARIANT_IDS) {
        let passed = false;
        try {
          passed = options.run(id, candidateId) === true;
        } catch {
          passed = false;
        }
        results.push({ id, passed });
        if (!passed) failedIds.push(id);
      }
      for (const id of CORE_INVARIANT_IDS) {
        if (!results.some((result) => result.id === id)) missingIds.push(id);
      }
      const report: RegressionReport = {
        passed: failedIds.length === 0 && missingIds.length === 0,
        results: Object.freeze(results),
        failedIds: Object.freeze(failedIds),
        missingIds: Object.freeze(missingIds),
      };
      return Object.freeze(report);
    },
  };
}

export function assertRegressionPassed(report: RegressionReport): true {
  if (!report.passed) {
    throw new Error(`REGRESSION_FAILED: ${report.failedIds.join(",") || "missing"}`);
  }
  return true;
}

/** 24 条不变量读取的真实上下文；legacy 看已执行结果，plugin 从冻结事件独立重算。 */
export interface RegressionContext {
  readonly candidateId: string;
  readonly events: readonly EpisodeEvent[];
  readonly replay: ReplayResult;
  readonly evaluation: FitnessEvaluation;
  readonly heldOut: HeldOutResult;
  readonly ab: ABComparison;
  readonly snapshotDigest: string;
}

function probeActions(events: readonly EpisodeEvent[]): readonly { kind: string; cellId: string }[] {
  const actions: { kind: string; cellId: string }[] = [];
  for (const event of events) {
    for (const action of event.batch) {
      if (action.kind === "probe" || action.kind === "step") {
        actions.push({ kind: action.kind, cellId: action.cellId });
      }
    }
  }
  return actions;
}

function expectedScores(events: readonly EpisodeEvent[]): number[] {
  const byCell = new Map<string, number>();
  for (const event of events) {
    for (const outcome of event.outcomes) byCell.set(outcome.cellId, outcome.failed ? 0 : outcome.score);
  }
  return probeActions(events).map((action) => byCell.get(action.cellId) ?? Number.NaN);
}

function expectedValidity(events: readonly EpisodeEvent[]): boolean[] {
  const byCell = new Map<string, boolean>();
  for (const event of events) {
    for (const outcome of event.outcomes) byCell.set(outcome.cellId, outcome.valid);
  }
  return probeActions(events).map((action) => byCell.get(action.cellId) ?? false);
}

function expectedFailed(events: readonly EpisodeEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    for (const outcome of event.outcomes) if (outcome.failed) ids.push(outcome.cellId);
  }
  return ids;
}

function safely(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

/**
 * 真实执行 24 条不变量（12 条 × legacy/plugin）。每条都是可失败的谓词，
 * 不接受宿主注入的恒真 gate；failed replay 与空 episode 会在这里被拒绝。
 */
export function runCoreInvariants(context: RegressionContext): RegressionReport {
  const { replay, events, evaluation, heldOut, ab } = context;
  const scores = expectedScores(events);
  const validity = expectedValidity(events);
  const failed = expectedFailed(events);
  const actions = probeActions(events);
  const cells = new Set(
    events.flatMap((event) => [...event.before, ...event.after].map((cell) => cell.id))
  );

  // legacy：直接审阅本轮 replay 的真实执行结果。
  const legacy: readonly (() => boolean)[] = [
    () => replay.spent === replay.order.length,
    () => new Set(replay.order).size === replay.order.length,
    () => replay.legal.length === replay.spent && replay.legal.every(Boolean),
    () => replay.best <= replay.runBest,
    () => replay.spent <= replay.budget,
    () => replay.failed.length === 0,
    () => events.length > 0 && events.every((event) => event.batch.length > 0),
    () => replay.observations.length === replay.order.length,
    () => replay.observations.every((item, index) => item.budgetSpent === index + 1),
    () => replay.identityDigest.length > 0,
    () => Number.isFinite(evaluation.reward) && evaluation.scoredTraces > 0,
    () => Number.isFinite(heldOut.score) && Number.isFinite(ab.delta ?? 0),
  ];

  // plugin：从冻结事件独立重算，不复用 replay 已经给出的可信事实。
  const plugin: readonly (() => boolean)[] = [
    () => actions.length === replay.budget,
    () => actions.map((action) => action.cellId).join("|") === replay.order.join("|"),
    () =>
      events.every((event) =>
        event.outcomes.every(
          (outcome) =>
            Number.isFinite(outcome.score) && typeof outcome.valid === "boolean"
        )
      ),
    () => replay.observations.every((item, index) => item.score === scores[index]),
    () => replay.failed.join("|") === failed.join("|"),
    () =>
      events.every(
        (event) => event.parallelism >= 1 && event.parallelism <= event.batch.length
      ),
    () => new Set(events.flatMap((event) => event.outcomes.map((item) => item.cellId))).size ===
      events.reduce((total, event) => total + event.outcomes.length, 0),
    () => actions.every((action) => cells.has(action.cellId)),
    () => replay.observations.every((item, index) => item.valid === validity[index]),
    () =>
      events.length === 0 ||
      replay.identityDigest === identityDigest(events[0]!.identity),
    () => context.snapshotDigest.length > 0,
    () => ab.treatmentScore === evaluation.reward,
  ];

  const results: { id: string; passed: boolean }[] = [];
  const failedIds: string[] = [];
  const missingIds: string[] = [];
  for (let index = 0; index < CORE_INVARIANT_IDS.length; index += 1) {
    const id = CORE_INVARIANT_IDS[index]!;
    const check = index % 2 === 0 ? legacy[index / 2] : plugin[(index - 1) / 2];
    const passed = check === undefined ? false : safely(check);
    results.push({ id, passed });
    if (!passed) failedIds.push(id);
  }
  for (const id of CORE_INVARIANT_IDS) {
    if (!results.some((result) => result.id === id)) missingIds.push(id);
  }
  return Object.freeze({
    passed: failedIds.length === 0 && missingIds.length === 0,
    results: Object.freeze(results),
    failedIds: Object.freeze(failedIds),
    missingIds: Object.freeze(missingIds),
  });
}

export interface PromotionPipelineOptions {
  readonly identity: EpisodeIdentity;
  readonly store: FrozenStore;
  readonly snapshot: FrozenSnapshot;
  /** 回归门是必填依赖，未注入时无法构造 pipeline。 */
  readonly regressionGate: RegressionGate;
  readonly incumbent?: Candidate;
  readonly incumbentHeldOut?: number;
  readonly evaluator?: FitnessEvaluator;
  readonly audit?: AuditSink;
  readonly heldOutThreshold?: number;
  readonly objectiveKeys?: readonly string[];
  readonly now?: () => number;
}

export interface PromotionRequest {
  readonly candidateId: string;
  readonly artifact: PromotionArtifact;
  readonly expectedDigest: string;
  /** 必须与冻结快照中的剧情事件逐字一致。 */
  readonly events: readonly EpisodeEvent[];
  readonly traces: readonly FitnessTrace[];
  readonly heldOutScores: Readonly<Record<string, number>>;
  readonly split: SearchTestSplit;
  readonly objectives: Readonly<Record<string, number>>;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly observationKeys: readonly string[];
  /** HMR generation 作为版本谱系标签，必须为正整数。 */
  readonly generation: number;
  /** 一次性授权 nonce；缺省由 pipeline 生成，禁止外部复用同一授权。 */
  readonly nonce?: string;
}

export interface HeldOutResult {
  readonly score: number;
  readonly threshold: number;
  readonly testIds: readonly string[];
}

export interface PromotionOutcome {
  readonly state: PromotionState;
  readonly decision: PromotionState["history"][number];
  readonly candidate: Candidate;
  readonly evaluation: FitnessEvaluation;
  readonly replay: ReplayResult;
  readonly ab: ABComparison;
  readonly heldOut: HeldOutResult;
  readonly candidates: { readonly candidate: ObjectiveVector; readonly incumbent?: ObjectiveVector };
  readonly reasons: readonly string[];
  readonly stages: readonly PromotionStage[];
  readonly generation: number;
  /** 本轮真实执行的 24 条不变量报告，作为回归证据随结果返回。 */
  readonly regression: RegressionReport;
  /** 在 held-out 评分之前算出的 search 阶段 Pareto 前沿。 */
  readonly frontier: readonly string[];
  /** held-out 评分次数；正常路径恒为 1，绝不重复评分。 */
  readonly heldOutEvaluations: number;
  /** 一次性授权绑定的 nonce，便于审计追踪。 */
  readonly nonce: string;
}

export interface PromotionPipeline {
  readonly stages: readonly PromotionStage[];
  run(request: PromotionRequest): PromotionOutcome;
}

function emptyReplay(identity: EpisodeIdentity): ReplayResult {
  return Object.freeze({
    mode: "replay" as const,
    identityDigest: identityDigest(identity),
    budget: 0,
    spent: 0,
    order: Object.freeze([]),
    best: 0,
    runBest: 0,
    legal: Object.freeze([]),
    failed: Object.freeze([]),
    observations: Object.freeze([]),
  });
}

function emptyEvaluation(): FitnessEvaluation {
  return Object.freeze({ reward: 0, auc: 0, penalty: 0, scoredTraces: 0 });
}

function emptyRegressionReport(): RegressionReport {
  return Object.freeze({
    passed: false,
    results: Object.freeze([]),
    failedIds: Object.freeze([]),
    missingIds: CORE_INVARIANT_IDS,
  });
}

function sealedCandidate(
  id: string,
  fitness: number,
  qualified: boolean,
  identityDigestValue: string
): Candidate {
  const body = { id, fitness, qualified, fingerprint: undefined };
  return Object.freeze({
    ...body,
    seal: issuePromotionSeal({ candidateId: id, identityDigest: identityDigestValue, body }),
  });
}

function objectiveVector(
  id: string,
  values: Readonly<Record<string, number>>,
  keys: readonly string[]
): ObjectiveVector {
  const selected: Record<string, number> = {};
  for (const key of keys) {
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`INVALID_OBJECTIVE: ${key}`);
    }
    selected[key] = value;
  }
  return Object.freeze({ id, values: Object.freeze(selected) });
}

export function createPromotionPipeline(options: PromotionPipelineOptions): PromotionPipeline {
  const {
    identity,
    store,
    snapshot,
    regressionGate,
    incumbent,
    evaluator = createFitnessEvaluator(),
    audit,
    heldOutThreshold = 0.5,
    objectiveKeys = ["reward", "heldOut"],
    now = Date.now,
  } = options;
  if (incumbent !== undefined && !isSealedPromotion(incumbent.seal)) {
    throw new Error("PROMOTION_SEAL_REQUIRED");
  }
  if (!Number.isFinite(heldOutThreshold) || heldOutThreshold < 0 || heldOutThreshold > 1) {
    throw new Error("INVALID_HELD_OUT_THRESHOLD");
  }
  if (!Array.isArray(objectiveKeys) || objectiveKeys.length === 0) {
    throw new Error("INVALID_OBJECTIVES");
  }
  const baseState = createPromotionState(incumbent);

  function record(decisionName: string, request: PromotionRequest, digest: string): void {
    if (audit === undefined) return;
    audit.append({
      ts: now(),
      actor: `research:${identity.run}`,
      tenant: identity.tenant,
      pluginId: "research",
      toolName: "promotion-pipeline",
      argsDigest: identityDigest(identity),
      decision: decisionName,
      resultDigest: `${request.candidateId}:${digest}`,
      causalId: request.candidateId,
    });
  }

  return {
    stages: PROMOTION_STAGES,
    run(request) {
      if (request.nonce !== undefined && (typeof request.nonce !== "string" || request.nonce.length === 0)) {
        throw new Error("INVALID_PROMOTION_NONCE");
      }
      const nonce = request.nonce ?? randomBytes(16).toString("hex");
      const authorizationBinding = (): PromotionAuthorizationBinding =>
        Object.freeze({
          candidateId: request.candidateId,
          artifactDigest: digest,
          snapshotDigest: snapshot.manifest.digest,
          identityDigest: identityDigest(identity),
          nonce,
        });
      const stages: PromotionStage[] = [];
      const reasons: string[] = [];
      const advance = (stage: PromotionStage): void => {
        stages.push(stage);
      };
      let digest = "";
      let evaluation = emptyEvaluation();
      let replay = emptyReplay(identity);
      let ab: ABComparison = Object.freeze({
        controlScore: undefined,
        treatmentScore: undefined,
        delta: undefined,
        eligible: false,
      });
      let heldOut: HeldOutResult = Object.freeze({
        score: 0,
        threshold: heldOutThreshold,
        testIds: request.split.test,
      });
      let vectors: PromotionOutcome["candidates"] = {
        candidate: objectiveVector(request.candidateId, request.objectives, objectiveKeys),
      };
      let candidate: Candidate = sealedCandidate(
        request.candidateId,
        0,
        false,
        identityDigest(identity)
      );
      let heldOutEvaluations = 0;
      let frontierIds: readonly string[] = Object.freeze([]);
      let regression: RegressionReport = emptyRegressionReport();

      const reject = (reason: PromotionRejectionReason): PromotionOutcome => {
        reasons.push(reason);
        record("RESEARCH_PROMOTION_REJECTED", request, digest);
        const state = recordPromotionRejection(baseState, candidate, reason, digest || undefined);
        return Object.freeze({
          state,
          decision: state.history[state.history.length - 1]!,
          candidate,
          evaluation,
          replay,
          ab,
          heldOut,
          candidates: vectors,
          reasons: Object.freeze(reasons),
          stages: Object.freeze(stages),
          generation: request.generation,
          regression,
          frontier: frontierIds,
          heldOutEvaluations,
          nonce,
        });
      };

      if (
        typeof request.candidateId !== "string" ||
        request.candidateId.length === 0 ||
        !Number.isInteger(request.generation) ||
        request.generation < 1
      ) {
        throw new Error("INVALID_PROMOTION_REQUEST");
      }

      advance("digest");
      digest = sha256Hex(request.artifact);
      if (!matchesArtifactDigest(request.artifact, request.expectedDigest)) {
        return reject("digest-mismatch");
      }

      advance("budget");
      try {
        replay = replayEpisode(request.events, {
          identity,
          store,
          snapshot,
          incumbentScore: incumbent?.fitness,
        });
        assertReplayInvariants(replay, { events: request.events });
      } catch (error) {
        throw new Error(
          `PIPELINE_BUDGET_VIOLATION: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      advance("observation");
      assertObservationEquivalence(request.before, request.after, request.observationKeys);

      advance("tripwire");
      assertSearchTestIsolation(request.split, request.split.search);
      assertNoGraderVerdicts({
        [`${request.candidateId}.ts`]:
          typeof request.artifact === "string" ? request.artifact : `bytes:${request.artifact.length}`,
        ...snapshot.evidence,
      });

      evaluation = evaluator.evaluate({
        seal: issueEvaluatorSeal({
          candidateId: request.candidateId,
          identityDigest: identityDigest(identity),
        }),
        traces: request.traces,
        candidateId: request.candidateId,
        identityDigest: identityDigest(identity),
      });

      // A/B 结果先算出，供回归不变量读取；阶段推进仍在 compare。
      const harness = createABHarness();
      if (incumbent !== undefined) harness.control.record(incumbent.id, incumbent.fitness);
      harness.treatment.record(request.candidateId, evaluation.reward);
      ab = compareAB(harness, incumbent?.id ?? "__no-incumbent__", request.candidateId);

      advance("eligibility");
      // held-out 只能在 search 阶段前沿确定之后评一次；前沿本身只用 search 目标。
      const searchKeys = objectiveKeys.filter((key) => key !== "heldOut");
      const frontierKeys = searchKeys.length > 0 ? searchKeys : objectiveKeys;
      const searchCandidate = objectiveVector(request.candidateId, request.objectives, frontierKeys);
      const searchIncumbent =
        incumbent === undefined
          ? undefined
          : objectiveVector(
              incumbent.id,
              Object.fromEntries(
                frontierKeys.map((key) => [key, key === "reward" ? incumbent.fitness : 0])
              ),
              frontierKeys
            );
      frontierIds = Object.freeze(
        paretoFrontier(
          [searchCandidate, ...(searchIncumbent === undefined ? [] : [searchIncumbent])],
          frontierKeys
        ).map((vector) => vector.id)
      );
      heldOutEvaluations += 1;
      heldOut = Object.freeze({
        score: scoreHeldOut(request.heldOutScores, request.split),
        threshold: heldOutThreshold,
        testIds: request.split.test,
      });
      const candidateVector = objectiveVector(
        request.candidateId,
        { ...request.objectives, heldOut: heldOut.score },
        objectiveKeys
      );
      const incumbentVector =
        incumbent === undefined
          ? undefined
          : objectiveVector(
              incumbent.id,
              {
                ...Object.fromEntries(objectiveKeys.map((key) => [key, 0])),
                reward: incumbent.fitness,
                heldOut: options.incumbentHeldOut ?? 0,
              },
              objectiveKeys
            );
      vectors = Object.freeze({ candidate: candidateVector, ...(incumbentVector === undefined ? {} : { incumbent: incumbentVector }) });
      if (heldOut.score < heldOutThreshold) return reject("held-out-below-threshold");
      if (
        incumbentVector !== undefined &&
        dominates(incumbentVector, candidateVector, objectiveKeys)
      ) {
        return reject("pareto-dominated");
      }

      advance("regression");
      // 真实 24 条不变量是权威回归依据；注入的 gate 只作为附加适配器，
      // 即使宿主注入恒真 gate 也无法绕过这里的真实执行。
      regression = runCoreInvariants({
        candidateId: request.candidateId,
        events: request.events,
        replay,
        evaluation,
        heldOut,
        ab,
        snapshotDigest: snapshot.manifest.digest,
      });
      const injectedRegression = regressionGate.verify(request.candidateId);
      if (!regression.passed || !injectedRegression.passed) return reject("regression-failed");

      advance("compare");
      if (incumbent !== undefined && !ab.eligible) return reject("not-strictly-better");

      advance("commit");
      candidate = sealedCandidate(
        request.candidateId,
        evaluation.reward,
        true,
        identityDigest(identity)
      );
      const binding = authorizationBinding();
      bindPromotionAuthorization(candidate.seal, binding);
      const state = promote(baseState, candidate);
      consumePromotionAuthorization(candidate.seal, binding);
      const decision = state.history[state.history.length - 1]!;
      record("RESEARCH_PROMOTION_COMMITTED", request, digest);
      return Object.freeze({
        state,
        decision,
        candidate,
        evaluation,
        replay,
        ab,
        heldOut,
        candidates: vectors,
        reasons: Object.freeze(reasons),
        stages: Object.freeze(stages),
        generation: request.generation,
        regression,
        frontier: frontierIds,
        heldOutEvaluations,
        nonce,
      });
    },
  };
}

export function assertPipelineInvariants(outcome: PromotionOutcome): true {
  const stageIndexes = outcome.stages.map((stage) => PROMOTION_STAGES.indexOf(stage));
  if (stageIndexes.length === 0 || stageIndexes.some((index) => index < 0)) {
    throw new Error("PIPELINE_INVARIANT: stage-order");
  }
  for (let index = 1; index < stageIndexes.length; index += 1) {
    if (stageIndexes[index]! <= stageIndexes[index - 1]!) {
      throw new Error("PIPELINE_INVARIANT: stage-order");
    }
  }
  if (outcome.state.history[outcome.state.history.length - 1] !== outcome.decision) {
    throw new Error("PIPELINE_INVARIANT: decision-history");
  }
  if (outcome.replay.spent !== outcome.replay.order.length) {
    throw new Error("PIPELINE_INVARIANT: budget-order");
  }
  if (outcome.replay.spent > outcome.replay.budget || outcome.replay.best > outcome.replay.runBest) {
    throw new Error("PIPELINE_INVARIANT: replay-bounds");
  }
  if (outcome.decision.promoted) {
    if (outcome.state.incumbent?.id !== outcome.decision.candidate.id) {
      throw new Error("PIPELINE_INVARIANT: promoted-incumbent");
    }
    if (outcome.state.incumbent?.fitness !== outcome.evaluation.reward) {
      throw new Error("PIPELINE_INVARIANT: promoted-fitness");
    }
  } else {
    if (outcome.state.incumbent?.id === outcome.decision.candidate.id) {
      throw new Error("PIPELINE_INVARIANT: rejected-incumbent");
    }
    if (
      outcome.state.incumbent !== undefined &&
      outcome.decision.fitness !== outcome.state.incumbent.fitness
    ) {
      throw new Error("PIPELINE_INVARIANT: rejected-fitness");
    }
  }
  return true;
}
