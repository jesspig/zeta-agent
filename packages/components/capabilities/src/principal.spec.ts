import { describe, expect, test } from "bun:test";
import { createPrincipalResolver, realmForSpace, RealmScoped } from "./principal";

describe("T-13 Principal resolver 与 realm 作用域", () => {
  test("同一 spaceId 解析到同一 realm，不同 spaceId 解析到不同 realm", () => {
    const resolve = createPrincipalResolver({ defaultUserId: "system" });
    const a1 = resolve({ spaceId: "space-a", userId: "u-a" });
    const a2 = resolve({ spaceId: "space-a", userId: "u-a" });
    const b = resolve({ spaceId: "space-b", userId: "u-b" });

    expect(a1.userId).toBe("u-a");
    expect(a1.spaceId).toBe("space-a");
    expect(a1.realm).toBe(a2.realm);
    expect(a1.realm).not.toBe(b.realm);
    expect(realmForSpace("space-a")).toBe(realmForSpace("space-a"));
    expect(realmForSpace("space-a")).not.toBe(realmForSpace("space-b"));
  });

  test("resolver 注入 agent/session/tool/audit/research 时各消费者看到同一 principal", () => {
    const resolve = createPrincipalResolver();
    const principal = resolve({ spaceId: "space-x", userId: "user-x" });
    // 四个消费点都由同一 resolver 注入，不得各自重新推导 realm。
    const consumers = {
      agent: principal,
      session: principal,
      tool: principal,
      audit: principal,
      research: principal,
    };
    for (const value of Object.values(consumers)) {
      expect(value).toBe(principal);
      expect(value.realm).toBe(realmForSpace("space-x"));
    }
  });

  test("RealmScoped 按 realm 隔离：兄弟 realm 不受 dispose 影响，缺失明确失败", () => {
    const scoped = new RealmScoped<string>();
    const realmA = realmForSpace("scope-a");
    const realmB = realmForSpace("scope-b");
    const stopA = scoped.provide(realmA, "a");
    scoped.provide(realmB, "b");

    expect(scoped.require(realmA)).toBe("a");
    expect(scoped.require(realmB)).toBe("b");
    expect(() => scoped.provide(realmA, "again")).toThrow("REALM_SCOPE_DUPLICATE");

    stopA();
    expect(() => scoped.require(realmA)).toThrow("REALM_SCOPE_MISSING");
    expect(scoped.require(realmB)).toBe("b");
    scoped.disposeRealm(realmB);
    expect(() => scoped.require(realmB)).toThrow("REALM_SCOPE_MISSING");
  });
});
