import { describe, expect, test } from "bun:test";
import {
  assertBudgetIdentity,
  createFitnessSeam,
  evaluateFitness,
  NOOP_FITNESS,
} from "./fitness";
import type { BudgetIdentityTrace } from "./fitness.evaluator";

function trace(overrides: Partial<BudgetIdentityTrace> = {}): BudgetIdentityTrace {
  return {
    budget: 2,
    order: ["a", "b"],
    isLegal: (id) => id === "a" || id === "b",
    best: 8,
    runBest: 10,
    ...overrides,
  };
}

describe("SE-H11 / A17 预算恒等式护栏", () => {
  test("一致的 replay trace 通过全部恒等式检查", () => {
    expect(assertBudgetIdentity(trace())).toBe(true);
  });

  test("budget 必须等于 order.length", () => {
    expect(() => assertBudgetIdentity(trace({ budget: 3 }))).toThrow(/BUDGET_IDENTITY_MISMATCH/);
  });

  test("重复 id 在计数之前被拒绝", () => {
    expect(() => assertBudgetIdentity(trace({ order: ["a", "a"] }))).toThrow(/BUDGET_DUPLICATE_ID/);
  });

  test("执行序中的非法步骤被拒绝", () => {
    expect(() => assertBudgetIdentity(trace({ order: ["a", "c"] }))).toThrow(/BUDGET_ILLEGAL_ACTION/);
  });

  test("best 不得超过 runBest", () => {
    expect(() => assertBudgetIdentity(trace({ best: 11 }))).toThrow(/BUDGET_RUNBEST_VIOLATION/);
  });

  test("既有字段有限性校验保留", () => {
    expect(() => assertBudgetIdentity(trace({ budget: Number.NaN }))).toThrow(/INVALID_FITNESS_FIELD/);
    expect(() => assertBudgetIdentity(trace({ runBest: Number.POSITIVE_INFINITY }))).toThrow(
      /INVALID_FITNESS_FIELD/
    );
  });

  test("护栏为可选项：默认 evaluator 与 NOOP seam 行为不变", () => {
    const candidate = {
      traces: [
        {
          runBest: 10,
          nEvaluated: 2,
          points: [
            { budget: 1, best: 5, sequentialRounds: 1 },
            { budget: 2, best: 10, sequentialRounds: 2 },
          ],
        },
      ],
    };

    expect(evaluateFitness(candidate).reward).toBeGreaterThan(0);
    expect(NOOP_FITNESS.evaluate(candidate)).toBe(0);
    expect(createFitnessSeam().evaluate(candidate)).toBe(0);
  });
});
