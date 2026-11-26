import { describe, expect, test } from "bun:test";
import * as agent from "../index";
import { listAssembly } from "../facade";
import { CORE_INVARIANT_IDS } from "./pipeline";

describe("T-25 研究轨公开出口与默认装配边界", () => {
  test("pipeline/fitness/experience 公开，seal 签发函数不公开", () => {
    expect(typeof agent.createPromotionPipeline).toBe("function");
    expect(typeof agent.createFitnessEvaluator).toBe("function");
    expect(typeof agent.createExperienceLibrary).toBe("function");
    expect(typeof agent.createRegressionGate).toBe("function");
    expect("issuePromotionSeal" in agent).toBe(false);
    expect("issueEvaluatorSeal" in agent).toBe(false);
  });

  test("低阶 promote 系列不再从公开 API 可达，真实回归 runner 公开", () => {
    for (const lowLevel of [
      "promote",
      "promoteWithDigest",
      "promoteWithObservationEquivalence",
      "replayPromotion",
      "recordPromotionRejection",
      "createPromotionState",
    ]) {
      expect(lowLevel in agent).toBe(false);
    }
    expect(typeof agent.runCoreInvariants).toBe("function");
    expect(typeof agent.createOrderedReplaySurface).toBe("function");
    expect(typeof agent.referenceFitness).toBe("function");
  });

  test("研究轨仍不进入默认装配", () => {
    for (const id of listAssembly()) {
      expect(id).not.toMatch(/research|promotion|fitness|experience|evolution/i);
    }
  });

  test("回归门覆盖 12 条核心不变量的 legacy/plugin 双版", () => {
    expect(CORE_INVARIANT_IDS).toHaveLength(24);
    expect(new Set(CORE_INVARIANT_IDS).size).toBe(24);
    for (const variant of ["legacy", "plugin"]) {
      expect(CORE_INVARIANT_IDS.filter((id) => id.endsWith(`-${variant}`))).toHaveLength(12);
    }
  });
});
