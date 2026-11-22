import { describe, expect, test } from "bun:test";
import { checkBudget, DEFAULT_PERFORMANCE_BUDGET } from "./budget";

/** CR-37：缺失的必填指标/上限必须被拒绝，不能与 undefined 比较后放行。 */
describe("T-37 预算必填字段校验", () => {
  test("缺失 metrics 字段抛错", () => {
    expect(() =>
      checkBudget({ startupMs: 100, memBytes: 100 } as never, DEFAULT_PERFORMANCE_BUDGET)
    ).toThrow(/INVALID_METRIC|token/i);
  });

  test("缺失 budget 字段抛错", () => {
    expect(() =>
      checkBudget(
        { startupMs: 100, memBytes: 100, tokenCost: 100 },
        { maxStartupMs: 200, maxMemBytes: 200 } as never,
      )
    ).toThrow(/INVALID_BUDGET|token/i);
  });
});
