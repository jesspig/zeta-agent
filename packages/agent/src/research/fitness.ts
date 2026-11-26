import { assertEvaluatorSeal, type EvaluatorSeal } from "./seal";

export interface FitnessPoint {
  readonly budget: number;
  readonly best: number;
  readonly sequentialRounds: number;
}

export interface FitnessTrace {
  readonly name?: string;
  readonly runBest: number;
  readonly nEvaluated: number;
  readonly points: readonly FitnessPoint[];
}

export interface FitnessEvaluatorConfig {
  readonly parallelismWeight?: number;
  readonly minEvalForAuc?: number;
}

export interface FitnessEvaluation {
  readonly reward: number;
  readonly auc: number;
  readonly penalty: number;
  readonly scoredTraces: number;
}

/** evaluator 只接受由 pipeline 签发的 seal；裸输入会在边界处抛错。 */
export interface SealedEvaluation {
  readonly seal: EvaluatorSeal;
  readonly traces: readonly FitnessTrace[];
  readonly candidateId: string;
  readonly identityDigest: string;
}

export interface FitnessEvaluator {
  evaluate(sealed: SealedEvaluation): FitnessEvaluation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteOrThrow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`INVALID_FITNESS_FIELD: ${label}`);
  }
  return value;
}

/** 预算轴上的归一化 attainment 曲线积分，0..1；点数不足或预算跨度为 0 时为零。 */
export function attainmentAuc(
  points: readonly FitnessPoint[],
  runBest: number,
  minEvalForAuc: number
): number {
  if (!Array.isArray(points)) throw new Error("INVALID_FITNESS_POINTS");
  if (runBest <= 0 || !Number.isFinite(runBest)) throw new Error("INVALID_FITNESS_RUNBEST");
  const usable = points
    .filter((point) => point.budget > 0)
    .map((point) => ({
      x: finiteOrThrow(point.budget, "budget"),
      y: Math.max(0, Math.min(finiteOrThrow(point.best, "best") / runBest, 1)),
    }))
    .sort((left, right) => left.x - right.x);
  if (usable.length < minEvalForAuc) return 0;

  const minBudget = usable[0]!.x;
  const maxBudget = usable[usable.length - 1]!.x;
  const span = maxBudget - minBudget;
  if (span <= 0 || minBudget <= 0) return 0;

  let area = 0;
  for (let index = 1; index < usable.length; index += 1) {
    const left = usable[index - 1]!;
    const right = usable[index]!;
    area += (right.x - left.x) * ((left.y + right.y) / 2);
  }
  return Math.max(0, Math.min(area / span, 1));
}

function parallelismPenalty(points: readonly FitnessPoint[]): number {
  const ratios = points
    .filter((point) => point.budget > 0)
    .map((point) => finiteOrThrow(point.sequentialRounds, "sequentialRounds") / point.budget);
  return ratios.length === 0
    ? 1
    : ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length;
}

/** SE-D5/M7：reward = 平均 attainment AUC − λ·平均并行惩罚。 */
export function evaluateFitness(
  sealed: SealedEvaluation,
  config: FitnessEvaluatorConfig = {}
): FitnessEvaluation {
  if (!isRecord(sealed)) throw new Error("EVALUATOR_SEAL_REQUIRED");
  assertEvaluatorSeal(sealed.seal);
  const weight = config.parallelismWeight ?? 0.25;
  const minEvalForAuc = config.minEvalForAuc ?? 2;
  if (!Number.isFinite(weight) || weight < 0) throw new Error("INVALID_PARALLELISM_WEIGHT");
  if (!Number.isInteger(minEvalForAuc) || minEvalForAuc < 2) throw new Error("INVALID_MIN_EVAL");
  if (!Array.isArray(sealed.traces)) throw new Error("INVALID_FITNESS_CANDIDATE");

  let aucTotal = 0;
  let penaltyTotal = 0;
  for (const raw of sealed.traces) {
    if (!isRecord(raw) || !Array.isArray(raw.points)) throw new Error("INVALID_FITNESS_TRACE");
    const runBest = finiteOrThrow(raw.runBest, "runBest");
    const nEvaluated = finiteOrThrow(raw.nEvaluated, "nEvaluated");
    if (runBest <= 0) throw new Error("INVALID_FITNESS_TRACE: runBest");
    if (nEvaluated < minEvalForAuc) throw new Error("INVALID_FITNESS_TRACE: nEvaluated");
    const points: FitnessPoint[] = raw.points.map((point) => {
      if (!isRecord(point)) throw new Error("INVALID_FITNESS_POINT");
      return {
        budget: finiteOrThrow(point.budget, "budget"),
        best: finiteOrThrow(point.best, "best"),
        sequentialRounds: finiteOrThrow(point.sequentialRounds, "sequentialRounds"),
      };
    });
    aucTotal += attainmentAuc(points, runBest, minEvalForAuc);
    penaltyTotal += parallelismPenalty(points);
  }

  const scoredTraces = sealed.traces.length;
  if (scoredTraces === 0) return { reward: -weight, auc: 0, penalty: 0, scoredTraces: 0 };
  const auc = aucTotal / scoredTraces;
  const penalty = penaltyTotal / scoredTraces;
  return { reward: auc - weight * penalty, auc, penalty, scoredTraces };
}

/**
 * 唯一参考公式：reward = 平均 attainment AUC − λ·平均并行惩罚，
 * λ = 0.25，AUC 最少两点。所有默认路径共用这一组参数。
 */
export const REFERENCE_FITNESS_CONFIG: FitnessEvaluatorConfig = Object.freeze({
  parallelismWeight: 0.25,
  minEvalForAuc: 2,
});

export function referenceFitness(sealed: SealedEvaluation): FitnessEvaluation {
  return evaluateFitness(sealed, REFERENCE_FITNESS_CONFIG);
}

export function createFitnessEvaluator(config: FitnessEvaluatorConfig = {}): FitnessEvaluator {
  const effective = Object.keys(config).length === 0 ? REFERENCE_FITNESS_CONFIG : config;
  return Object.freeze({
    evaluate: (sealed: SealedEvaluation) => evaluateFitness(sealed, effective),
  });
}

export interface ExperimentRecord {
  readonly candidate: string;
  readonly score: number;
}

export interface Experiment {
  readonly id: string;
  record(candidate: string, score: number): void;
  score(candidate: string): number | undefined;
  entries(): readonly ExperimentRecord[];
}

export function createExperiment(id: string): Experiment {
  if (typeof id !== "string" || id.length === 0) throw new Error("EXPERIMENT_ID_REQUIRED");
  const scores = new Map<string, number>();
  return {
    id,
    record(candidate, score) {
      if (typeof candidate !== "string" || candidate.length === 0) {
        throw new Error("CANDIDATE_REQUIRED");
      }
      if (!Number.isFinite(score)) throw new Error(`INVALID_SCORE: ${candidate}`);
      scores.set(candidate, score);
    },
    score(candidate) {
      return scores.get(candidate);
    },
    entries() {
      return Object.freeze([...scores].map(([name, value]) => Object.freeze({ candidate: name, score: value })));
    },
  };
}

export interface ABComparison {
  readonly controlScore: number | undefined;
  readonly treatmentScore: number | undefined;
  readonly delta: number | undefined;
  readonly eligible: boolean;
}

export interface ABHarness {
  readonly control: Experiment;
  readonly treatment: Experiment;
  compare(controlId: string, treatmentId: string): ABComparison;
}

/** A/B 两臂各自持有独立 Experiment，search/test 不共享写入面。 */
export function createABHarness(): ABHarness {
  const control = createExperiment("control");
  const treatment = createExperiment("treatment");
  return Object.freeze({
    control,
    treatment,
    compare(controlId: string, treatmentId: string) {
      const controlScore = control.score(controlId);
      const treatmentScore = treatment.score(treatmentId);
      return Object.freeze({
        controlScore,
        treatmentScore,
        delta:
          controlScore === undefined || treatmentScore === undefined
            ? undefined
            : treatmentScore - controlScore,
        eligible:
          controlScore !== undefined &&
          treatmentScore !== undefined &&
          treatmentScore > controlScore,
      });
    },
  });
}

export function compareAB(
  harness: ABHarness,
  controlId: string,
  treatmentId: string
): ABComparison {
  return harness.compare(controlId, treatmentId);
}

export interface ObjectiveVector {
  readonly id: string;
  readonly values: Readonly<Record<string, number>>;
}

function objectiveValue(vector: ObjectiveVector, objective: string): number {
  const value = vector.values[objective];
  return finiteOrThrow(value, `objective:${objective}`);
}

/** 全部目标不劣、至少一个目标严格更优。 */
export function dominates(
  a: ObjectiveVector,
  b: ObjectiveVector,
  objectives: readonly string[]
): boolean {
  let strictlyBetter = false;
  for (const objective of objectives) {
    const left = objectiveValue(a, objective);
    const right = objectiveValue(b, objective);
    if (left < right) return false;
    if (left > right) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function paretoFrontier(
  candidates: readonly ObjectiveVector[],
  objectives: readonly string[]
): readonly ObjectiveVector[] {
  return Object.freeze(
    candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other.id !== candidate.id && dominates(other, candidate, objectives)
        )
    )
  );
}

export interface SearchTestSplit {
  readonly search: readonly string[];
  readonly test: readonly string[];
  readonly salt: string;
  readonly holdout: number;
}

export interface SplitOptions {
  readonly salt?: string;
  readonly holdout?: number;
}

function hashId(salt: string, id: string): number {
  let hash = 2166136261;
  for (const char of `${salt}:${id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** SE-M11：按确定性哈希划分 search/test，test id 永不进入改进上下文。 */
export function createSearchTestSplit(ids: readonly string[], options: SplitOptions = {}): SearchTestSplit {
  if (!Array.isArray(ids) || ids.length < 2) throw new Error("INVALID_SPLIT");
  const salt = options.salt ?? "default";
  const holdout = options.holdout ?? 0.25;
  if (typeof salt !== "string" || salt.length === 0) throw new Error("INVALID_SPLIT");
  if (!Number.isFinite(holdout) || holdout <= 0 || holdout >= 1) throw new Error("INVALID_SPLIT");
  const unique = [...new Set(ids)].sort();
  if (unique.length !== ids.length || unique.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("INVALID_SPLIT");
  }

  const test: string[] = [];
  const search: string[] = [];
  for (const id of unique) {
    if (hashId(salt, id) % 1000 < holdout * 1000) test.push(id);
    else search.push(id);
  }
  if (test.length === 0) {
    const moved = search.pop()!;
    test.push(moved);
  }
  if (search.length === 0) {
    const moved = test.shift()!;
    search.push(moved);
  }
  return Object.freeze({
    search: Object.freeze(search.sort()),
    test: Object.freeze(test.sort()),
    salt,
    holdout,
  });
}

export function assertSearchTestIsolation(
  split: SearchTestSplit,
  searchPhaseIds: readonly string[]
): true {
  if (split.search.some((id) => split.test.includes(id))) {
    throw new Error("SEARCH_TEST_LEAK: split overlap");
  }
  for (const id of searchPhaseIds) {
    if (split.test.includes(id)) throw new Error(`SEARCH_TEST_LEAK: ${id}`);
  }
  return true;
}

export function scoreHeldOut(
  scores: Readonly<Record<string, number>>,
  split: SearchTestSplit
): number {
  if (split.test.length === 0) throw new Error("HELD_OUT_MISSING: split");
  let total = 0;
  for (const id of split.test) {
    const value = scores[id];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`HELD_OUT_MISSING: ${id}`);
    }
    total += value;
  }
  return total / split.test.length;
}
