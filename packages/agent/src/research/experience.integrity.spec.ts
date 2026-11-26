import { describe, expect, test } from "bun:test";
import {
  assertNoGraderVerdicts,
  assertRawTraceIntegrity,
  createExperienceLibrary,
  createExperienceScope,
  createExperienceStore,
  rawTraceDigest,
  retrieveExperience,
  type ExperienceEntry,
} from "./experience";

const scope = createExperienceScope({ tenant: "tenant-i", domain: "coding", mode: "live" });

function entry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "e-i",
    candidate: "c-i",
    kind: "edit",
    code: "const next = 1 + 1;",
    scores: { fitness: 0.7 },
    traces: ["step-1", "step-2"],
    tenant: scope.tenant,
    domain: scope.domain,
    mode: scope.mode,
    realm: scope.realm,
    cue: "cue",
    lesson: "lesson",
    evidence: "evidence",
    ...overrides,
  };
}

describe("T-22 ExperienceLibrary earlier-only 与 raw trace 完整性", () => {
  test("earlier-only：before 只取 step 严格更早的条目，未来/同一步不可见", () => {
    const library = createExperienceLibrary(createExperienceStore(), scope);
    library.put(entry({ id: "t1", step: 1 }));
    library.put(entry({ id: "t2", step: 2 }));
    library.put(entry({ id: "t3", step: 3 }));
    library.put(entry({ id: "no-step" }));

    expect(retrieveExperience(library, { before: 3 }).map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(retrieveExperience(library, { before: 1 })).toEqual([]);
    expect(retrieveExperience(library, { before: 4 }).map((item) => item.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(retrieveExperience(library, {}).map((item) => item.id)).toContain("no-step");
  });

  test("raw trace 全文逐字入库，截断、空串与 digest 不匹配都被拒绝", () => {
    const digest = rawTraceDigest(["full-trace-a", "full-trace-b"]);
    expect(
      assertRawTraceIntegrity(entry({ traces: ["full-trace-a", "full-trace-b"], traceDigest: digest }))
    ).toBe(true);

    expect(() => libraryPut(entry({ traces: ["half..."] }))).toThrow(/RAW_TRACE_TRUNCATED/);
    expect(() => libraryPut(entry({ traces: [] }))).toThrow(/RAW_TRACE_INVALID/);
    expect(() => libraryPut(entry({ traces: ["", "b"] }))).toThrow(/RAW_TRACE_INVALID/);
    expect(() => libraryPut(entry({ traceDigest: "0".repeat(64) }))).toThrow(
      /RAW_TRACE_DIGEST_MISMATCH/
    );
  });

  test("深冻结 + earlier-only 组合返回条目仍不可变", () => {
    const library = createExperienceLibrary(createExperienceStore(), scope);
    library.put(entry({ id: "deep", step: 1, nested: { values: [1, 2] } }));
    const found = retrieveExperience(library, { before: 2 })[0]!;
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.scores)).toBe(true);
    expect(Object.isFrozen(found.nested)).toBe(true);
    expect(() => {
      (found.nested as { values: number[] }).values.push(3);
    }).toThrow();
  });

  test("grader verdict / 判分标记污染 trace 与输出字段无法入库", () => {
    expect(() =>
      libraryPut(entry({ traces: ["graderScore=99"] }))
    ).toThrow(/LEAK/i);
    expect(() =>
      libraryPut(entry({ scores: { fitness: 0.7, testPassRate: 1 } }))
    ).toThrow(/LEAK/i);
    expect(() =>
      assertNoGraderVerdicts({ "report.json": { verdict: "pass" } })
    ).toThrow(/LEAK/i);
    expect(() => libraryPut(entry())).not.toThrow();
  });
});

function libraryPut(candidate: ExperienceEntry): void {
  const library = createExperienceLibrary(createExperienceStore(), scope);
  library.put(candidate);
}
