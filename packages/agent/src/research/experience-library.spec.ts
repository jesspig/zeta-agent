import { describe, expect, test } from "bun:test";
import { realmForSpace } from "@zeta-agent/capabilities";
import {
  createExperienceLibrary,
  createExperienceScope,
  createExperienceStore,
  hasTransferableExperience,
  retrieveExperience,
  type ExperienceEntry,
  type ExperienceScope,
} from "./experience";

function scoped(
  store: ReturnType<typeof createExperienceStore>,
  overrides: Partial<ExperienceScope> = {}
): ReturnType<typeof createExperienceLibrary> {
  const scope = createExperienceScope({
    tenant: "tenant-a",
    domain: "coding",
    mode: "live",
    ...overrides,
  });
  return createExperienceLibrary(store, scope);
}

function entry(
  overrides: Partial<ExperienceEntry> = {},
  scope: ExperienceScope = createExperienceScope({
    tenant: "tenant-a",
    domain: "coding",
    mode: "live",
  })
): ExperienceEntry {
  return {
    id: "e1",
    candidate: "c1",
    kind: "edit",
    code: "const next = 1 + 1;",
    scores: { fitness: 0.5 },
    traces: ["step-a"],
    tenant: scope.tenant,
    domain: scope.domain,
    mode: scope.mode,
    realm: scope.realm,
    cue: "slow-start",
    lesson: "probe early",
    evidence: "trace-a",
    ...overrides,
  };
}

describe("T-25 ExperienceLibrary 不可变与隔离", () => {
  test("domain/mode/tenant/realm 四维隔离，跨 scope 不可见不可写", () => {
    const store = createExperienceStore();
    const live = scoped(store);
    const otherTenant = scoped(store, { tenant: "tenant-b" });
    const otherDomain = scoped(store, { domain: "writing" });
    const replay = scoped(store, { mode: "replay" });

    live.put(entry());
    expect(live.get("e1")?.id).toBe("e1");
    expect(otherTenant.get("e1")).toBeUndefined();
    expect(otherDomain.get("e1")).toBeUndefined();
    expect(replay.get("e1")).toBeUndefined();
    expect(otherTenant.all()).toEqual([]);

    expect(() => otherTenant.put(entry())).toThrow(/EXPERIENCE_SCOPE_MISMATCH/);
    expect(() =>
      live.put(entry({ id: "e2", tenant: "tenant-b", realm: realmForSpace("tenant-b") }))
    ).toThrow(/EXPERIENCE_SCOPE_MISMATCH/);
  });

  test("principal 提供 realm 时按 spaceId 绑定租户", () => {
    const scope = createExperienceScope({
      tenant: "tenant-p",
      domain: "coding",
      mode: "replay",
      principal: {
        userId: "u1",
        spaceId: "tenant-p",
        realm: realmForSpace("tenant-p"),
      },
    });
    expect(scope.realm).toBe(realmForSpace("tenant-p"));
    expect(() =>
      createExperienceScope({
        tenant: "tenant-q",
        domain: "coding",
        mode: "live",
        principal: {
          userId: "u1",
          spaceId: "tenant-p",
          realm: realmForSpace("tenant-p"),
        },
      })
    ).toThrow(/EXPERIENCE_SCOPE_MISMATCH/);
  });

  test("条目深冻结且同 id 不可覆写", () => {
    const library = scoped(createExperienceStore());
    library.put(entry({ id: "e-frozen", nested: { cue: "x" } }));
    const stored = library.get("e-frozen")!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.scores)).toBe(true);
    expect(Object.isFrozen(stored.nested)).toBe(true);
    expect(() => {
      (stored.scores as Record<string, number>).fitness = 0;
    }).toThrow();
    expect(() => library.put(entry({ id: "e-frozen", code: "changed" }))).toThrow(
      /EXPERIENCE_IMMUTABLE/
    );
    expect(library.get("e-frozen")?.code).toBe("const next = 1 + 1;");
  });

  test("非马尔可夫检索可取回任意历史条目，要求 cue/lesson/evidence 齐全", () => {
    const library = scoped(createExperienceStore());
    library.put(entry({ id: "old-1", candidate: "ancient", code: "alpha();" }));
    library.put(entry({ id: "old-2", candidate: "ancient", code: "beta();", lesson: undefined }));
    library.put(entry({ id: "new-1", candidate: "recent", code: "gamma();" }));

    expect(retrieveExperience(library, { candidate: "ancient" }).map((item) => item.id)).toEqual([
      "old-1",
      "old-2",
    ]);
    expect(retrieveExperience(library, { regex: "^alpha" }).map((item) => item.id)).toEqual([
      "old-1",
    ]);
    expect(hasTransferableExperience(library.get("old-1")!)).toBe(true);
    expect(hasTransferableExperience(library.get("old-2")!)).toBe(false);
    expect(retrieveExperience(library, { candidate: "ancient", transferable: true }).map((i) => i.id)).toEqual([
      "old-1",
    ]);
  });

  test("test 结果与任务特定字符串 tripwire 拦截入库", () => {
    const library = scoped(createExperienceStore());
    expect(() => library.put(entry({ code: "testPassRate = 1" }))).toThrow(/LEAK/i);
    expect(() => library.put(entry({ traces: ["heldOutAnswer: ABC"] }))).toThrow(/LEAK/i);
    expect(() => library.put(entry())).not.toThrow();
  });
});
