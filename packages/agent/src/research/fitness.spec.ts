import { describe, expect, test } from "bun:test";
import { issueEvaluatorSeal } from "./seal";
import {
  assertSearchTestIsolation,
  attainmentAuc,
  compareAB,
  createABHarness,
  createFitnessEvaluator,
  createSearchTestSplit,
  dominates,
  evaluateFitness,
  paretoFrontier,
  referenceFitness,
  scoreHeldOut,
  type FitnessPoint,
  type FitnessTrace,
  type ObjectiveVector,
  type SealedEvaluation,
} from "./fitness";

function point(budget: number, best: number, sequentialRounds: number): FitnessPoint {
  return { budget, best, sequentialRounds };
}

function trace(overrides: Partial<FitnessTrace> = {}): FitnessTrace {
  return {
    name: "t1",
    runBest: 1,
    nEvaluated: 2,
    points: [point(1, 0.25, 1), point(3, 0.75, 2)],
    ...overrides,
  };
}

function sealed(
  traces: readonly FitnessTrace[] = [trace()],
  candidateId = "cand-1"
): SealedEvaluation {
  return {
    seal: issueEvaluatorSeal({ candidateId, identityDigest: "identity-1" }),
    traces,
    candidateId,
    identityDigest: "identity-1",
  };
}

describe("T-25 fitness evaluator：AUC/惩罚/可插拔", () => {
  test("attainment AUC 按预算梯形积分，点数不足时为零", () => {
    const points = [point(1, 0.25, 1), point(3, 0.75, 2)];
    expect(attainmentAuc(points, 1, 2)).toBeCloseTo(0.5);
    expect(attainmentAuc(points, 1, 3)).toBe(0);
    expect(attainmentAuc([point(1, 1, 1), point(1, 1, 1)], 1, 2)).toBe(0);
  });

  test("reward = 平均 AUC − λ·平均并行惩罚，配置可调", () => {
    const result = evaluateFitness(sealed(), { parallelismWeight: 0.25 });
    expect(result.scoredTraces).toBe(1);
    expect(result.auc).toBeCloseTo(0.5);
    expect(result.penalty).toBeCloseTo(5 / 6);
    expect(result.reward).toBeCloseTo(0.5 - (0.25 * 5) / 6);

    const noPenalty = evaluateFitness(sealed(), { parallelismWeight: 0 });
    expect(noPenalty.reward).toBeCloseTo(0.5);
  });

  test("可插拔 evaluator 与真实 evaluator 共用同一入口", () => {
    const custom = createFitnessEvaluator({ parallelismWeight: 0 });
    expect(custom.evaluate(sealed()).reward).toBeCloseTo(0.5);
    expect(() => evaluateFitness(sealed([trace({ runBest: -1 })]))).toThrow(
      /INVALID_FITNESS/
    );
  });

  test("参考公式黄金向量：AUC=1/2、惩罚=5/6、reward=7/24", () => {
    const golden = referenceFitness(sealed());
    expect(golden.auc).toBeCloseTo(0.5, 10);
    expect(golden.penalty).toBeCloseTo(5 / 6, 10);
    expect(golden.reward).toBeCloseTo(7 / 24, 10);
    expect(golden.scoredTraces).toBe(1);
    expect(createFitnessEvaluator().evaluate(sealed())).toEqual(golden);
  });
});

describe("T-25 evaluator 防绕过", () => {
  test("无 seal、伪造 seal 与裸 trace 都不能调用 evaluator", () => {
    const evaluator = createFitnessEvaluator();
    const bare = { traces: [trace()], candidateId: "cand", identityDigest: "id" };
    expect(() => evaluator.evaluate(bare as unknown as SealedEvaluation)).toThrow(
      /EVALUATOR_SEAL_REQUIRED/
    );
    expect(() =>
      evaluator.evaluate({
        ...bare,
        seal: { kind: "evaluator", candidateId: "cand", identityDigest: "id" },
      } as unknown as SealedEvaluation)
    ).toThrow(/EVALUATOR_SEAL_REQUIRED/);
    expect(() => evaluateFitness(bare as unknown as SealedEvaluation)).toThrow(
      /EVALUATOR_SEAL_REQUIRED/
    );
  });
});

describe("T-25 A/B 实验隔离", () => {
  test("control/treatment 各自独立记录，比较给出 delta", () => {
    const harness = createABHarness();
    harness.control.record("base", 0.4);
    harness.treatment.record("cand", 0.7);

    expect(harness.control.score("cand")).toBeUndefined();
    expect(harness.treatment.score("base")).toBeUndefined();
    expect(harness.control.entries()).toEqual([{ candidate: "base", score: 0.4 }]);

    const comparison = compareAB(harness, "base", "cand");
    expect(comparison.controlScore).toBe(0.4);
    expect(comparison.treatmentScore).toBe(0.7);
    expect(comparison.delta).toBeCloseTo(0.3);
    expect(compareAB(harness, "base", "missing").eligible).toBe(false);
  });
});

describe("T-25 Pareto 多目标", () => {
  const objectives = ["reward", "heldOut"] as const;

  test("支配与非支配前沿按全部目标判定", () => {
    const a: ObjectiveVector = { id: "a", values: { reward: 0.7, heldOut: 0.6 } };
    const b: ObjectiveVector = { id: "b", values: { reward: 0.5, heldOut: 0.5 } };
    const c: ObjectiveVector = { id: "c", values: { reward: 0.5, heldOut: 0.8 } };

    expect(dominates(a, b, objectives)).toBe(true);
    expect(dominates(b, a, objectives)).toBe(false);
    expect(dominates(a, c, objectives)).toBe(false);
    expect(paretoFrontier([a, b, c], objectives).map((item) => item.id)).toEqual(["a", "c"]);
  });
});

describe("T-25 search/test 分离与 held-out", () => {
  test("切分确定、互斥且拒绝 search 阶段使用 test id", () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    const first = createSearchTestSplit(ids, { salt: "seed-1", holdout: 0.25 });
    expect(first).toEqual(createSearchTestSplit(ids, { salt: "seed-1", holdout: 0.25 }));
    expect(createSearchTestSplit(ids, { salt: "seed-2", holdout: 0.25 })).not.toEqual(first);
    expect(first.search.some((id) => first.test.includes(id))).toBe(false);
    expect(first.search.length + first.test.length).toBe(ids.length);

    expect(assertSearchTestIsolation(first, first.search)).toBe(true);
    expect(() => assertSearchTestIsolation(first, [first.test[0]!])).toThrow(
      /SEARCH_TEST_LEAK/
    );
    expect(() => createSearchTestSplit([], {})).toThrow(/INVALID_SPLIT/);
  });

  test("held-out 分数只取 test 集合，缺失分数立即失败", () => {
    const split = createSearchTestSplit(["a", "b", "c", "d"], { salt: "s", holdout: 0.25 });
    const scores: Record<string, number> = {};
    for (const id of split.test) scores[id] = 0.8;
    for (const id of split.search) scores[id] = 0.1;
    expect(scoreHeldOut(scores, split)).toBeCloseTo(0.8);

    delete scores[split.test[0]!];
    expect(() => scoreHeldOut(scores, split)).toThrow(/HELD_OUT_MISSING/);
  });
});
