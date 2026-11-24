import type { FitnessEvaluator } from "./fitness";

export interface FitnessPoint {
  /** 该探针累计消耗的计算预算（必须为正）。 */
  readonly budget: number;
  /** 该预算下达到的最佳成绩。 */
  readonly best: number;
  /** 等效串行轮数；相对预算越大，并行收益越差。 */
  readonly sequentialRounds: number;
}

export interface FitnessTrace {
  readonly name?: string;
  /** 本次运行可达的最佳成绩，用于归一化 attainment。 */
  readonly runBest: number;
  /** 可探测节点数；过小则 AUC 没有区分度。 */
  readonly nEvaluated: number;
  readonly points: readonly FitnessPoint[];
}

export interface FitnessEvaluatorConfig {
  /** 并行惩罚权重，非负值；越大越惩罚串行探针。 */
  readonly parallelismWeight?: number;
  /** 参与 AUC 计算所需的最少探针数，默认 2。 */
  readonly minEvalForAuc?: number;
}

export interface FitnessEvaluation {
  readonly reward: number;
  readonly auc: number;
  readonly penalty: number;
  readonly scoredTraces: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrThrow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`INVALID_FITNESS_FIELD: ${label}`);
  return value;
}

/** 单条 replay trace 的预算账本：预算、执行序、合法性判定与观测最佳。 */
export interface BudgetIdentityTrace {
  readonly budget: number;
  readonly order: readonly string[];
  readonly isLegal: (id: string) => boolean;
  readonly best: number;
  readonly runBest: number;
}

/**
 * SE-H11/A17 可选护栏：对齐预算恒等式。
 * 重复 id 先于计数检查，因为重复恰好能伪装成账面上的满足。
 */
export function assertBudgetIdentity(trace: unknown): true {
  if (!isRecord(trace)) throw new Error("INVALID_BUDGET_IDENTITY_TRACE");
  const budget = finiteOrThrow(trace.budget, "budget");
  const best = finiteOrThrow(trace.best, "best");
  const runBest = finiteOrThrow(trace.runBest, "runBest");
  if (!Number.isInteger(budget) || budget < 0) throw new Error("INVALID_FITNESS_FIELD: budget");
  if (!Array.isArray(trace.order)) throw new Error("INVALID_BUDGET_ORDER");
  if (typeof trace.isLegal !== "function") throw new Error("INVALID_IS_LEGAL");
  const isLegal = trace.isLegal as (id: string) => boolean;

  const seen = new Set<string>();
  for (const id of trace.order) {
    if (typeof id !== "string" || id.length === 0) throw new Error("INVALID_BUDGET_ORDER_ID");
    if (seen.has(id)) throw new Error(`BUDGET_DUPLICATE_ID: ${id}`);
    seen.add(id);
  }
  if (budget !== trace.order.length) {
    throw new Error(`BUDGET_IDENTITY_MISMATCH: budget=${budget} order=${trace.order.length}`);
  }
  for (const id of trace.order) {
    if (!isLegal(id)) throw new Error(`BUDGET_ILLEGAL_ACTION: ${id}`);
  }
  if (best > runBest + 1e-9) {
    throw new Error(`BUDGET_RUNBEST_VIOLATION: best=${best} runBest=${runBest}`);
  }
  return true;
}

/** 预算↔成绩曲线的归一化面积（观察等价的梯形近似，结果落在 0..1）。 */
export function attainmentAuc(points: readonly FitnessPoint[], runBest: number, minEvalForAuc: number): number {
  const usable = points
    .filter((point) => point.budget > 0)
    .map((point) => ({
      x: point.budget,
      y: Math.max(0, Math.min(point.best / runBest, 1)),
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
    .map((point) => point.sequentialRounds / point.budget);
  return ratios.length === 0 ? 1 : ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length;
}

/** 真实 evaluator：reward = 平均 attainment AUC − 权重 × 平均串行惩罚。 */
export function evaluateFitness(candidate: unknown, config: FitnessEvaluatorConfig = {}): FitnessEvaluation {
  const weight = config.parallelismWeight ?? 0.25;
  const minEvalForAuc = config.minEvalForAuc ?? 2;
  if (!Number.isFinite(weight) || weight < 0) throw new Error("INVALID_PARALLELISM_WEIGHT");
  if (!Number.isInteger(minEvalForAuc) || minEvalForAuc < 2) throw new Error("INVALID_MIN_EVAL");

  if (!isRecord(candidate) || !Array.isArray(candidate.traces)) throw new Error("INVALID_FITNESS_CANDIDATE");
  let aucTotal = 0;
  let penaltyTotal = 0;
  let scoredTraces = 0;

  for (const raw of candidate.traces) {
    if (!isRecord(raw) || !Array.isArray(raw.points)) throw new Error("INVALID_FITNESS_TRACE");
    const runBest = finiteOrThrow(raw.runBest, "runBest");
    const nEvaluated = finiteOrThrow(raw.nEvaluated, "nEvaluated");
    if (runBest <= 0 || nEvaluated < minEvalForAuc) continue;
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
    scoredTraces += 1;
  }

  if (scoredTraces === 0) return { reward: -weight, auc: 0, penalty: 0, scoredTraces: 0 };
  const auc = aucTotal / scoredTraces;
  const penalty = penaltyTotal / scoredTraces;
  return { reward: auc - weight * penalty, auc, penalty, scoredTraces };
}

/** 可注入 seam 的真实实现；默认装配仍由 createFitnessSeam() 的 NOOP 提供。 */
export function createRewardEvaluator(config: FitnessEvaluatorConfig = {}): FitnessEvaluator {
  return {
    evaluate(candidate) {
      return evaluateFitness(candidate, config).reward;
    },
  };
}
