import { describe, expect, test } from "bun:test";
import {
  checkBudget,
  DEFAULT_PERFORMANCE_BUDGET,
  type PerfMetrics,
  type PerformanceBudget,
} from "./budget";

const budget: PerformanceBudget = {
  maxStartupMs: 500,
  maxMemBytes: 64 * 1024 * 1024,
  maxTokenCost: 8000,
};
const within: PerfMetrics = { startupMs: 300, memBytes: 32 * 1024 * 1024, tokenCost: 4000 };

describe("T-29 performance budget and regression gate", () => {
  test("checkBudget passes within budget and returns a boolean", () => {
    expect(checkBudget(within, budget)).toBe(true);
  });

  test("checkBudget throws when any metric exceeds its threshold", () => {
    expect(() => checkBudget({ ...within, startupMs: 501 }, budget)).toThrow(/startup/i);
    expect(() => checkBudget({ ...within, memBytes: 64 * 1024 * 1024 + 1 }, budget)).toThrow(/mem/i);
    expect(() => checkBudget({ ...within, tokenCost: 8001 }, budget)).toThrow(/token/i);
  });

  test("thresholds are inclusive", () => {
    expect(checkBudget({ startupMs: 500, memBytes: 64 * 1024 * 1024, tokenCost: 8000 }, budget)).toBe(true);
  });

  test("invalid budget and metrics are rejected", () => {
    expect(() => checkBudget(within, { ...budget, maxStartupMs: 0 })).toThrow(/budget/i);
    expect(() => checkBudget({ ...within, startupMs: -1 }, budget)).toThrow(/metric/i);
  });

  test("default budget exposes startup, memory and token thresholds", () => {
    expect(DEFAULT_PERFORMANCE_BUDGET.maxStartupMs).toBeGreaterThan(0);
    expect(DEFAULT_PERFORMANCE_BUDGET.maxMemBytes).toBeGreaterThan(0);
    expect(DEFAULT_PERFORMANCE_BUDGET.maxTokenCost).toBeGreaterThan(0);
    expect(checkBudget(within, DEFAULT_PERFORMANCE_BUDGET)).toBe(true);
  });
});
