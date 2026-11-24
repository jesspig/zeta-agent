export interface FitnessEvaluator {
  evaluate(candidate: unknown): number;
}

// 真实 evaluator 由 fitness 子路径一并提供；默认装配仍只暴露 NOOP seam。
export { assertBudgetIdentity, attainmentAuc, createRewardEvaluator, evaluateFitness } from "./fitness.evaluator";
export type {
  BudgetIdentityTrace,
  FitnessEvaluation,
  FitnessEvaluatorConfig,
  FitnessPoint,
  FitnessTrace,
} from "./fitness.evaluator";

export const NOOP_FITNESS: FitnessEvaluator = Object.freeze({
  evaluate: () => 0,
});

export function createFitnessSeam(evaluator: FitnessEvaluator = NOOP_FITNESS): FitnessEvaluator {
  return evaluator;
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
      if (typeof candidate !== "string" || candidate.length === 0) throw new Error("CANDIDATE_REQUIRED");
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

export function createABHarness(): { readonly control: Experiment; readonly treatment: Experiment } {
  return Object.freeze({
    control: createExperiment("control"),
    treatment: createExperiment("treatment"),
  });
}
