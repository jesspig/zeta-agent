export interface Candidate {
  readonly id: string;
  readonly fitness: number;
  readonly qualified: boolean;
}

export interface PromotionDecision {
  readonly candidate: Candidate;
  readonly promoted: boolean;
  readonly fitness: number;
}

export interface PromotionState {
  readonly incumbent: Candidate | undefined;
  readonly history: readonly PromotionDecision[];
}

function assertCandidate(candidate: Candidate): void {
  if (candidate === null || typeof candidate !== "object") throw new Error("INVALID_CANDIDATE");
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("INVALID_CANDIDATE: id required");
  }
  if (!Number.isFinite(candidate.fitness)) throw new Error(`INVALID_FITNESS: ${candidate.id}`);
  if (typeof candidate.qualified !== "boolean") {
    throw new Error(`INVALID_QUALIFIED: ${candidate.id}`);
  }
}

export function createPromotionState(initial?: Candidate): PromotionState {
  if (initial !== undefined) assertCandidate(initial);
  return Object.freeze({ incumbent: initial, history: Object.freeze([]) });
}

export function promote(state: PromotionState, candidate: Candidate): PromotionState {
  assertCandidate(candidate);
  const incumbent = state.incumbent;
  const promoted = candidate.qualified && (incumbent === undefined || candidate.fitness > incumbent.fitness);
  const nextIncumbent = promoted ? candidate : incumbent;
  const decision: PromotionDecision = Object.freeze({
    candidate,
    promoted,
    fitness: nextIncumbent?.fitness ?? 0,
  });
  return Object.freeze({
    incumbent: nextIncumbent,
    history: Object.freeze([...state.history, decision]),
  });
}

export function replayPromotion(candidates: readonly Candidate[], initial?: Candidate): PromotionState {
  return candidates.reduce(promote, createPromotionState(initial));
}

export function assertPromotionInvariants(
  state: PromotionState,
  considered: readonly Candidate[]
): boolean {
  if (state.history.length !== considered.length) throw new Error("PROMOTION_BUDGET_MISMATCH");
  if (new Set(state.history.map((item) => item.candidate.id)).size !== considered.length) {
    throw new Error("PROMOTION_DUPLICATE_CANDIDATE");
  }

  let lastFitness = Number.NEGATIVE_INFINITY;
  for (const decision of state.history) {
    if (decision.fitness < lastFitness) throw new Error("PROMOTION_NON_MONOTONIC");
    lastFitness = decision.fitness;
  }

  if (state.incumbent !== undefined) {
    for (const decision of state.history) {
      if (decision.fitness > state.incumbent.fitness) throw new Error("PROMOTION_RUNBEST_VIOLATION");
    }
  }
  return true;
}
