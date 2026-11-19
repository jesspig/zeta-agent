import { describe, expect, test } from "bun:test";
import { createABHarness, createExperiment, createFitnessSeam, NOOP_FITNESS } from "./fitness";

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
