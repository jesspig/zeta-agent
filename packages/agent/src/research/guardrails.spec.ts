import { describe, expect, test } from "bun:test";
import { listAssembly } from "../facade";
import {
  assertNoGraderVerdicts,
  createExperienceStore,
  GRADER_VERDICT_MARKERS,
  type ExperienceEntry,
} from "./experience";
import {
  assertObservationEquivalence,
  contextFingerprint,
  createPromotionState,
  promoteWithDigest,
  promoteWithObservationEquivalence,
  sha256Hex,
  type Candidate,
} from "./promotion";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return { id: "c1", fitness: 0.5, qualified: true, ...overrides };
}

function entry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "e1",
    candidate: "c1",
    kind: "edit",
    code: "const next = 1 + 1;",
    scores: { fitness: 0.5, cost: 12 },
    traces: ["step-a", "step-b"],
    ...overrides,
  };
}

describe("SE-D7 晋升前 digest 校验", () => {
  test("摘要不符时保留 incumbent，拒绝仍记入 history", () => {
    const state = createPromotionState(candidate({ id: "base", fitness: 0.5 }));
    const artifact = "candidate-v2";

    const next = promoteWithDigest(
      state,
      candidate({ id: "better", fitness: 0.9 }),
      { artifact, expectedDigest: "0".repeat(64) }
    );

    expect(next.incumbent?.id).toBe("base");
    expect(state.incumbent?.id).toBe("base");
    expect(next.history).toHaveLength(1);
    expect(next.history[0]!.candidate.id).toBe("better");
    expect(next.history[0]!.promoted).toBe(false);
    expect(next.history[0]!.reason).toBe("digest-mismatch");
    expect(next.history[0]!.digest).toBe(sha256Hex(artifact));
  });

  test("摘要一致且满足资格/严格更优时才替换", () => {
    const state = createPromotionState(candidate({ id: "base", fitness: 0.5 }));
    const artifact = new Uint8Array([1, 2, 3, 4]);

    const next = promoteWithDigest(
      state,
      candidate({ id: "better", fitness: 0.9 }),
      { artifact, expectedDigest: sha256Hex(artifact) }
    );

    expect(next.incumbent?.id).toBe("better");
    expect(next.history[0]!.promoted).toBe(true);
    expect(next.history[0]!.digest).toBe(sha256Hex(artifact));
    expect(next.history[0]!.reason).toBeUndefined();
  });

  test("非法摘要格式在比对前即抛错", () => {
    const state = createPromotionState();
    expect(() =>
      promoteWithDigest(state, candidate(), { artifact: "x", expectedDigest: "short" })
    ).toThrow(/digest/i);
  });
});

describe("SE-H3 / A18 观察等价晋升", () => {
  test("fingerprint 对键顺序稳定，对取值变化敏感", () => {
    const left = { b: 2, a: 1, nested: { y: 2, x: 1 } };
    const right = { nested: { x: 1, y: 2 }, a: 1, b: 2 };
    const changed = { ...left, a: 9 };

    expect(contextFingerprint(left)).toBe(contextFingerprint(right));
    expect(contextFingerprint(left)).not.toBe(contextFingerprint(changed));
    expect(contextFingerprint(left, ["a"])).not.toBe(contextFingerprint(left));
  });

  test("公开操作等价的 ctx 通过断言", () => {
    const before = { a: 1, nested: { x: 1 } };
    const after = { nested: { x: 1 }, a: 1 };

    expect(assertObservationEquivalence(before, after)).toBe(true);
    expect(assertObservationEquivalence(before, after, ["a"])).toBe(true);
  });

  test("键存在性、取值与描述符差异均触发断言", () => {
    expect(() => assertObservationEquivalence({ a: 1 }, { a: 1, b: 2 })).toThrow(/has\(b\)/);
    expect(() => assertObservationEquivalence({ a: 1 }, { a: 2 })).toThrow(/get\(a\)/);
    expect(() =>
      assertObservationEquivalence({ a: 1 }, { get a() { return 1; } })
    ).toThrow(/descriptor\(a\)/);
  });

  test("指纹与观察等价都通过才晋升", () => {
    const before = { mode: "base" };
    const after = { mode: "base" };
    const state = createPromotionState(candidate({ id: "base", fitness: 0.5 }));

    const next = promoteWithObservationEquivalence(
      state,
      candidate({ id: "better", fitness: 0.9, fingerprint: contextFingerprint(after) }),
      { before, after, keys: ["mode"] }
    );

    expect(next.incumbent?.id).toBe("better");
    expect(next.history).toHaveLength(1);
  });

  test("指纹不符或 ctx 变化均阻断晋升且不改动态", () => {
    const state = createPromotionState(candidate({ id: "base", fitness: 0.5 }));

    expect(() =>
      promoteWithObservationEquivalence(
        state,
        candidate({ id: "wrong-fp", fitness: 0.9, fingerprint: "0".repeat(64) }),
        { before: { mode: "base" }, after: { mode: "base" }, keys: ["mode"] }
      )
    ).toThrow(/FINGERPRINT_MISMATCH/);

    expect(() =>
      promoteWithObservationEquivalence(state, candidate({ id: "drifted", fitness: 0.9 }), {
        before: { mode: "base" },
        after: { mode: "changed" },
        keys: ["mode"],
      })
    ).toThrow(/OBSERVATION_EQUIVALENCE_MISMATCH/);

    expect(state.incumbent?.id).toBe("base");
    expect(state.history).toHaveLength(0);
  });
});

describe("SE-H8 / A19 语义级 grader verdict tripwire", () => {
  test("marker 清单覆盖 verdict/rubric/score 家族", () => {
    expect(GRADER_VERDICT_MARKERS).toContain("verdict");
    expect(GRADER_VERDICT_MARKERS).toContain("rubric");
    expect(GRADER_VERDICT_MARKERS).toContain("graderScore");
    expect(GRADER_VERDICT_MARKERS).toContain("pass_rate");
  });

  test("文件名命中 marker 时直接报 NAME", () => {
    expect(() => assertNoGraderVerdicts({ "verdict-report.md": "clean body" })).toThrow(/NAME/);
  });

  test("正文命中 marker 时报偏移与上下文", () => {
    const body = "before verdict after";
    let message = "";
    try {
      assertNoGraderVerdicts({ "rollout.md": body });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("verdict");
    expect(message).toContain(`offset ${body.indexOf("verdict")}`);
    expect(message).toContain(body);
  });

  test("可传自定义 marker，非文本后缀不扫正文", () => {
    expect(() => assertNoGraderVerdicts({ "notes.md": "custom text" }, ["custom"])).toThrow(
      /offset/
    );
    expect(() => assertNoGraderVerdicts({ "blob.bin": "custom text" }, ["custom"])).not.toThrow();
  });

  test("入库入口拦截 code/traces 中的判分内容但保留合法 scores", () => {
    const store = createExperienceStore();
    expect(() => store.put(entry({ code: "const verdict = 1;" }))).toThrow(/leak/i);
    expect(() => store.put(entry({ traces: ["graderScore=9"] }))).toThrow(/leak/i);
    expect(() => store.put(entry({ rubric: "r1" }))).toThrow(/leak/i);
    expect(() => store.put(entry({ scores: { fitness: 0.9 } }))).not.toThrow();
    expect(store.get("e1")?.scores.fitness).toBe(0.9);
  });

  test("研究护栏未进入默认装配清单", () => {
    const assembly = listAssembly();
    for (const id of assembly) {
      expect(id).not.toMatch(/research|experience|promotion|fitness|evolution/i);
    }
  });
});
