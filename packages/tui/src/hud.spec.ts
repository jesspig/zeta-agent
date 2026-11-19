import { describe, expect, test } from "bun:test";
import { contextBudget, renderHudPanel } from "./hud";

describe("T-27 debug HUD context budget panel", () => {
  test("context budget computes ratio, percent and severity level", () => {
    expect(contextBudget(4096, 8192)).toEqual({
      used: 4096,
      limit: 8192,
      ratio: 0.5,
      percent: 50,
      level: "ok",
    });
    expect(contextBudget(6000, 8192).level).toBe("warn");
    expect(contextBudget(8000, 8192).level).toBe("critical");
    expect(() => contextBudget(10, 0)).toThrow();
    expect(() => contextBudget(-1, 100)).toThrow();
  });

  test("HUD panel renders a stable multi-line context budget view", () => {
    const budget = contextBudget(4096, 8192);
    const panel = renderHudPanel(budget);

    expect(panel).toContain("4096/8192");
    expect(panel).toContain("50%");
    expect(panel).toContain("ok");
    expect(panel.split("\n").length).toBeGreaterThan(1);
    expect(renderHudPanel(budget)).toBe(panel);
  });
});
