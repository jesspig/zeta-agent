import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../runtime/agent";
import {
  RECAP_SEGMENTS,
  createRecap,
  createSessionSurface,
  type SemanticRecap,
} from "./surface";

const msg = (content: string): AgentMessage => ({ role: "user", content });

const fullRecap = {
  objective: "ship session compaction",
  establishedFacts: [{ text: "budget is dual threshold", kind: "observation" }],
  appliedChanges: [{ file: "surface.ts", what: "add surface", verified: true }],
  verification: [{ check: "bun test", result: "pass" }],
  deadEnds: ["free-text summary"],
  remainingPlan: ["implement offloader"],
} satisfies SemanticRecap;

describe("T-22 session surface and typed recap", () => {
  test("append preserves insertion order and replace keeps surrounding order", () => {
    const surface = createSessionSurface();
    surface.append(msg("a"));
    surface.append(msg("b"));
    surface.append(msg("c"));

    expect(surface.entries()).toEqual([
      { kind: "message", message: msg("a") },
      { kind: "message", message: msg("b") },
      { kind: "message", message: msg("c") },
    ]);

    const recap = createRecap(fullRecap);
    surface.replace({
      start: 0,
      end: 2,
      recap,
      uris: ["workspace:///block-1"],
      threshold: 100,
      preTokenCount: 40,
    });

    expect(surface.entries()).toEqual([
      { kind: "recap", recap, uris: ["workspace:///block-1"] },
      { kind: "message", message: msg("c") },
    ]);
  });

  test("typed recap contains exactly six segments and rejects malformed input", () => {
    expect(RECAP_SEGMENTS).toHaveLength(6);
    const recap = createRecap(fullRecap);
    expect(Object.keys(recap).sort()).toEqual([...RECAP_SEGMENTS].sort());

    const missing: Record<string, unknown> = { ...fullRecap };
    delete missing.deadEnds;
    expect(() => createRecap(missing as unknown as SemanticRecap)).toThrow();

    const extra = { ...fullRecap, surprise: 1 };
    expect(() => createRecap(extra as SemanticRecap)).toThrow();

    expect(() => createRecap({ ...fullRecap, objective: 42 } as unknown as SemanticRecap)).toThrow();
  });

  test("replace records compaction lineage with threshold recap uri and pre token count", () => {
    const surface = createSessionSurface();
    surface.append(msg("x"));
    const recap = createRecap(fullRecap);

    surface.replace({
      start: 0,
      end: 1,
      recap,
      uris: ["workspace:///u1", "workspace:///u2"],
      threshold: 128,
      preTokenCount: 64,
    });

    expect(surface.lineage()).toEqual([
      {
        threshold: 128,
        recap,
        uris: ["workspace:///u1", "workspace:///u2"],
        preTokenCount: 64,
      },
    ]);

    expect(() =>
      surface.replace({
        start: 2,
        end: 1,
        recap,
        uris: [],
        threshold: 1,
        preTokenCount: 1,
      })
    ).toThrow();
  });
});
