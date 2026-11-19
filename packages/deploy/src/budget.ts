export interface PerformanceBudget {
  readonly maxStartupMs: number;
  readonly maxMemBytes: number;
  readonly maxTokenCost: number;
}

export interface PerfMetrics {
  readonly startupMs: number;
  readonly memBytes: number;
  readonly tokenCost: number;
}

export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = Object.freeze({
  maxStartupMs: 2000,
  maxMemBytes: 256 * 1024 * 1024,
  maxTokenCost: 32000,
});

function assertBudget(budget: PerformanceBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`INVALID_BUDGET: ${name} must be a positive finite number`);
    }
  }
}

function assertMetrics(metrics: PerfMetrics): void {
  for (const [name, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`INVALID_METRIC: ${name} must be a non-negative finite number`);
    }
  }
}

export function checkBudget(metrics: PerfMetrics, budget: PerformanceBudget): boolean {
  assertBudget(budget);
  assertMetrics(metrics);

  if (metrics.startupMs > budget.maxStartupMs) {
    throw new Error(`BUDGET_EXCEEDED: startupMs ${metrics.startupMs} > ${budget.maxStartupMs}`);
  }
  if (metrics.memBytes > budget.maxMemBytes) {
    throw new Error(`BUDGET_EXCEEDED: memBytes ${metrics.memBytes} > ${budget.maxMemBytes}`);
  }
  if (metrics.tokenCost > budget.maxTokenCost) {
    throw new Error(`BUDGET_EXCEEDED: tokenCost ${metrics.tokenCost} > ${budget.maxTokenCost}`);
  }
  return true;
}
