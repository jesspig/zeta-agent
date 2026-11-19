export type BudgetLevel = "ok" | "warn" | "critical";

export interface ContextBudget {
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  readonly percent: number;
  readonly level: BudgetLevel;
}

declare module "./slots" {
  interface ZetaSlots {
    hud: { readonly budget: ContextBudget };
  }
}

export function contextBudget(used: number, limit: number): ContextBudget {
  if (!Number.isFinite(used) || used < 0) throw new Error("used: expected a non-negative number");
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("limit: expected a positive number");
  const ratio = used / limit;
  const percent = Math.round(ratio * 100);
  const level: BudgetLevel = percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";
  return { used, limit, ratio, percent, level };
}

export function renderHudPanel(budget: ContextBudget): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round(budget.ratio * width)));
  const bar = "#".repeat(filled) + ".".repeat(width - filled);
  return [
    "Context budget",
    `CTX ${budget.used}/${budget.limit} ${budget.percent}% [${budget.level}]`,
    bar,
  ].join("\n");
}
