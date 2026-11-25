import { describe, expect, test } from "bun:test";
import {
  assertPromotionInvariants,
  createPromotionState,
  promote,
  replayPromotion,
  type Candidate,
} from "./promotion";
import { issuePromotionSeal } from "./seal";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const body: Omit<Candidate, "seal"> = {
    id: "c1",
    fitness: 0.5,
    qualified: true,
    fingerprint: undefined,
    ...overrides,
  };
  return {
    ...body,
    seal: issuePromotionSeal({
      candidateId: body.id || "spec",
      identityDigest: "spec",
      body: {
        id: body.id,
        fitness: body.fitness,
        qualified: body.qualified,
        fingerprint: body.fingerprint,
      },
    }),
  };
}

describe("T-30 monotonic promotion and replay invariants", () => {
  test("only qualified and strictly better candidates replace the incumbent", () => {
    const base = candidate({ id: "base", fitness: 0.5 });
    let state = createPromotionState(base);

    state = promote(state, candidate({ id: "worse", fitness: 0.4 }));
    expect(state.incumbent?.id).toBe("base");

    state = promote(state, candidate({ id: "tie", fitness: 0.5 }));
    expect(state.incumbent?.id).toBe("base");

    state = promote(state, candidate({ id: "unqualified", fitness: 0.9, qualified: false }));
    expect(state.incumbent?.id).toBe("base");

    state = promote(state, candidate({ id: "better", fitness: 0.7 }));
    expect(state.incumbent?.id).toBe("better");
    expect(state.incumbent?.fitness).toBe(0.7);
  });

  test("fitness never decreases across a promotion sequence", () => {
    const base = candidate({ id: "base", fitness: 0.2 });
    const considered = [
      candidate({ id: "a", fitness: 0.1 }),
      candidate({ id: "b", fitness: 0.6 }),
      candidate({ id: "c", fitness: 0.4 }),
      candidate({ id: "d", fitness: 0.8 }),
    ];
    let state = createPromotionState(base);
    let lastFitness = state.incumbent?.fitness ?? Number.NEGATIVE_INFINITY;
    for (const item of considered) {
      state = promote(state, item);
      const current = state.incumbent?.fitness ?? Number.NEGATIVE_INFINITY;
      expect(current).toBeGreaterThanOrEqual(lastFitness);
      lastFitness = current;
    }
    expect(state.incumbent?.id).toBe("d");
  });

  test("promote is pure and does not mutate the input state", () => {
    const base = candidate({ id: "base", fitness: 0.5 });
    const state = createPromotionState(base);
    const next = promote(state, candidate({ id: "better", fitness: 0.9 }));

    expect(state.incumbent?.id).toBe("base");
    expect(state.history).toHaveLength(0);
    expect(next).not.toBe(state);
    expect(next.history).toHaveLength(1);
    expect(next.incumbent?.id).toBe("better");
  });

  test("replay honors budget, uniqueness and monotonicity invariants", () => {
    const base = candidate({ id: "base", fitness: 0.3 });
    const considered = [
      candidate({ id: "a", fitness: 0.5 }),
      candidate({ id: "b", fitness: 0.5 }),
      candidate({ id: "c", fitness: 0.2 }),
    ];
    const first = replayPromotion(considered, base);
    const second = replayPromotion(considered, base);

    expect(first).toEqual(second);
    expect(assertPromotionInvariants(first, considered)).toBe(true);
    expect(first.history).toHaveLength(considered.length);
    expect(new Set(first.history.map((item) => item.candidate.id)).size).toBe(considered.length);
  });

  test("invalid candidates are rejected", () => {
    const state = createPromotionState(candidate({ id: "base", fitness: 0.5 }));
    expect(() => promote(state, candidate({ id: "", fitness: 0.9 }))).toThrow(/candidate/i);
    expect(() => promote(state, candidate({ id: "x", fitness: Number.NaN }))).toThrow(/fitness/i);
  });
});
