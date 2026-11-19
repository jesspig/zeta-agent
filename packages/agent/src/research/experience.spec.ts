import { describe, expect, test } from "bun:test";
import { listAssembly } from "../facade";
import {
  createExperienceStore,
  replayExperience,
  type ExperienceEntry,
  type ExperienceOp,
} from "./experience";

function entry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "e1",
    candidate: "c1",
    kind: "edit",
    code: "const next = 1 + 1;",
    scores: { fitness: 0.5, cost: 12 },
    traces: ["step-a", "step-b"],
    createdAt: 1,
    ...overrides,
  };
}

describe("T-30 experience store and non-Markovian retrieval", () => {
  test("store persists every field losslessly through snapshot and restore", () => {
    const store = createExperienceStore();
    const full = entry({
      lineage: ["base", "mutant-1"],
      nested: { cue: "slow-start", confidence: 0.9 },
    });
    store.put(full);

    const snapshot = store.snapshot();
    const restored = createExperienceStore();
    restored.restore(snapshot);

    expect(restored.get("e1")).toEqual(full);
    expect(restored.all()).toEqual([full]);
    expect(restored.snapshot()).toBe(snapshot);
  });

  test("query retrieves arbitrary historical candidates by candidate, kind and regex", () => {
    const store = createExperienceStore();
    store.put(entry({ id: "a", candidate: "c1", kind: "edit", code: "alpha();" }));
    store.put(entry({ id: "b", candidate: "c1", kind: "recap", code: "beta();" }));
    store.put(entry({ id: "c", candidate: "c2", kind: "edit", code: "gamma();" }));

    expect(store.query({ candidate: "c1" }).map((item) => item.id)).toEqual(["a", "b"]);
    expect(store.query({ kind: "edit" }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(store.query({ candidate: "c1", kind: "recap" }).map((item) => item.id)).toEqual(["b"]);
    expect(store.query({ regex: "^alpha" }).map((item) => item.id)).toEqual(["a"]);
    expect(store.query({ regex: "(alpha|gamma)" }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(() => store.query({ regex: "[" })).toThrow(/regex/i);
  });

  test("frontier returns the best entries for a metric and diff computes deltas", () => {
    const store = createExperienceStore();
    store.put(entry({ id: "a", scores: { fitness: 0.5 }, code: "v1" }));
    store.put(entry({ id: "b", scores: { fitness: 0.9 }, code: "v2" }));
    store.put(entry({ id: "c", scores: { fitness: 0.9 }, code: "v2" }));

    expect(store.frontier("fitness").map((item) => item.id)).toEqual(["b", "c"]);
    expect(store.frontier("missing")).toEqual([]);

    const delta = store.diff("a", "b");
    expect(delta.a).toBe("a");
    expect(delta.b).toBe("b");
    expect(delta.scoreDelta.fitness).toBeCloseTo(0.4);
    expect(delta.codeChanged).toBe(true);
    expect(store.diff("b", "c").scoreDelta.fitness).toBe(0);
    expect(store.diff("b", "c").codeChanged).toBe(false);
  });

  test("replay is invariant: identical operations yield identical state", () => {
    const ops: ExperienceOp[] = [
      { kind: "put", entry: entry({ id: "a", scores: { fitness: 0.2 } }) },
      { kind: "put", entry: entry({ id: "b", scores: { fitness: 0.8 } }) },
    ];
    const first = replayExperience(ops);
    const second = replayExperience(ops);

    expect(first.snapshot()).toBe(second.snapshot());
    expect(first.all()).toEqual(second.all());
    expect(first.frontier("fitness").map((item) => item.id)).toEqual(["b"]);
  });

  test("search/test isolation tripwire throws on grader, rubric or test leakage", () => {
    const store = createExperienceStore();
    expect(() => store.put(entry({ verdict: "PASS" }))).toThrow(/leak/i);
    expect(() => store.put(entry({ rubric: "r1", graderScore: 9 }))).toThrow(/leak/i);
    expect(() => store.put(entry({ groundTruth: "answer", isTest: true }))).toThrow(/leak/i);
    expect(() => store.put(entry({ nested: { verdict: "PASS" } }))).toThrow(/leak/i);
    expect(() => store.put(entry())).not.toThrow();
  });

  test("research track is not part of the default assembly", () => {
    const assembly = listAssembly();
    for (const id of assembly) {
      expect(id).not.toMatch(/research|experience|promotion|fitness|evolution|seam|evidence/i);
    }
  });
});
