import { describe, expect, test } from "bun:test";
import { createABHarness, createExperiment, createFitnessSeam, NOOP_FITNESS } from "./fitness";
import { createRewardEvaluator, evaluateFitness } from "./fitness.evaluator";
import { checkBudget, DEFAULT_PERFORMANCE_BUDGET } from "./budget";

describe("T-29 fitness seam and A/B isolation", () => {
  test("NOOP_FITNESS is a no-op seam", () => {
    expect(NOOP_FITNESS.evaluate({ anything: 1 })).toBe(0);
    expect(NOOP_FITNESS.evaluate("candidate")).toBe(0);
  });

  test("createFitnessSeam defaults to no-op and accepts a custom evaluator", () => {
    expect(createFitnessSeam().evaluate("x")).toBe(0);
    const custom = { evaluate: (candidate: { score: number }) => candidate.score };
    expect(createFitnessSeam(custom).evaluate({ score: 7 })).toBe(7);
  });

  test("experiments keep independent state", () => {
    const a = createExperiment("A");
    const b = createExperiment("B");

    a.record("candidate-1", 0.8);
    expect(a.score("candidate-1")).toBe(0.8);
    expect(b.score("candidate-1")).toBeUndefined();

    b.record("candidate-1", 0.3);
    expect(a.score("candidate-1")).toBe(0.8);
    expect(b.score("candidate-1")).toBe(0.3);
  });

  test("A/B harness returns two isolated groups", () => {
    const { control, treatment } = createABHarness();
    control.record("x", 10);
    expect(treatment.entries()).toEqual([]);
    expect(Object.isFrozen(control.entries())).toBe(true);
    expect(control.score("x")).toBe(10);
  });

  test("recording a non-finite score is rejected", () => {
    const experiment = createExperiment("A");
    expect(() => experiment.record("bad", Number.NaN)).toThrow(/score/i);
    expect(() => experiment.record("bad", Number.POSITIVE_INFINITY)).toThrow(/score/i);
  });
});

describe("A29 真实 evaluator 可注入且保留 A/B 与预算门禁", () => {
  const candidate = {
    traces: [
      {
        name: "trace-1",
        runBest: 10,
        nEvaluated: 4,
        points: [
          { budget: 2, best: 5, sequentialRounds: 2 },
          { budget: 4, best: 10, sequentialRounds: 2 },
        ],
      },
    ],
  };

  test("reward = 平均 attainment AUC − 权重 × 平均串行惩罚", () => {
    const result = evaluateFitness(candidate, { parallelismWeight: 0.5 });
    expect(result.auc).toBeCloseTo(0.75);
    expect(result.penalty).toBeCloseTo(0.75);
    expect(result.reward).toBeCloseTo(0.375);
    expect(result.scoredTraces).toBe(1);

    // 无可评分轨迹时退化为 −weight，不伪装成 0 分。
    expect(evaluateFitness({ traces: [{ runBest: 0, nEvaluated: 4, points: [] }] }, { parallelismWeight: 0.25 }).reward).toBe(-0.25);
  });

  test("真实 evaluator 经 seam 注入生效，默认仍为 NOOP", () => {
    const evaluator = createRewardEvaluator({ parallelismWeight: 0.5 });
    const expected = evaluator.evaluate(candidate);
    expect(expected).toBeGreaterThan(0);
    expect(createFitnessSeam(evaluator).evaluate(candidate)).toBe(expected);
    expect(createFitnessSeam().evaluate(candidate)).toBe(0);
    expect(() => evaluator.evaluate({ traces: "not-an-array" })).toThrow(/INVALID_FITNESS/);
  });

  test("注入真实 evaluator 后 A/B 隔离与 checkBudget 门禁不受影响", () => {
    const reward = createRewardEvaluator({ parallelismWeight: 0.5 }).evaluate(candidate);
    const { control, treatment } = createABHarness();
    control.record("candidate-1", reward);
    expect(treatment.score("candidate-1")).toBeUndefined();
    expect(checkBudget({ startupMs: 100, memBytes: 1024, tokenCost: 10 }, DEFAULT_PERFORMANCE_BUDGET)).toBe(true);
    expect(() =>
      checkBudget({ startupMs: 99999, memBytes: 1024, tokenCost: 10 }, DEFAULT_PERFORMANCE_BUDGET)
    ).toThrow(/BUDGET_EXCEEDED/);
  });
});
