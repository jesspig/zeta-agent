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
  issueEvaluatorSeal,
  issuePromotionSeal,
  isSealedPromotion,
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
        assertReplayInvariants(replay);
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

      advance("eligibility");
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
      const regression = regressionGate.verify(request.candidateId);
      if (!regression.passed) return reject("regression-failed");

      advance("compare");
      const harness = createABHarness();
      if (incumbent !== undefined) harness.control.record(incumbent.id, incumbent.fitness);
      harness.treatment.record(request.candidateId, evaluation.reward);
      ab = compareAB(harness, incumbent?.id ?? "__no-incumbent__", request.candidateId);
      if (incumbent !== undefined && !ab.eligible) return reject("not-strictly-better");

      advance("commit");
      candidate = sealedCandidate(
        request.candidateId,
        evaluation.reward,
        true,
        identityDigest(identity)
      );
      const state = promote(baseState, candidate);
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
