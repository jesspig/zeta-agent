import { describe, expect, test } from "bun:test";
import { defineComponent, defineKey } from "@zeta-agent/framework";
import type { SessionStore } from "../session/store";
import type { DurableEffects } from "../plugins/effects/durable";
import type { AgentStreamFn } from "../facade";
import { createTenantGovernance } from "./governance";

function stubSession(sessionId: string): SessionStore {
  return { sessionId, close: () => {} } as unknown as SessionStore;
}

function stubEffects(tag: string): DurableEffects {
  return { tag } as unknown as DurableEffects;
}

describe("T-13 租户治理 realm 作用域", () => {
  test("同一 space 解析到同一 scope；不同 space 的 realm 与 scope 均隔离", () => {
    const governance = createTenantGovernance();
    const a1 = governance.resolve({ spaceId: "space-a", userId: "u-a" });
    const a2 = governance.resolve({ spaceId: "space-a", userId: "u-a" });
    const b = governance.resolve({ spaceId: "space-b", userId: "u-b" });

    expect(a1).toBe(a2);
    expect(a1.principal.spaceId).toBe("space-a");
    expect(a1.realm).toBe(a2.realm);
    expect(a1.realm).not.toBe(b.realm);
    expect(a1.context.realm).toBe(a1.realm);
    expect(governance.scopes.size).toBe(2);
    return governance.dispose();
  });

  test("provider/event/resource/session/effects/research 按 realm 解析不串", async () => {
    const key = defineKey<string>("@zeta-agent/t13-agent", "tenant-resource");
    const sessions = new Map<string, SessionStore>();
    const effects = new Map<string, DurableEffects>();
    const streams = new Map<string, AgentStreamFn>();
    const governance = createTenantGovernance({
      createSessionStore: (principal) => {
        const store = stubSession(principal.spaceId);
        sessions.set(principal.spaceId, store);
        return store;
      },
      createDurableEffects: (principal) => {
        const value = stubEffects(principal.spaceId);
        effects.set(principal.spaceId, value);
        return value;
      },
      createStreamFn: (principal) => {
        const stream = (() => {}) as unknown as AgentStreamFn;
        streams.set(principal.spaceId, stream);
        return stream;
      },
    });
    const a = governance.resolve({ spaceId: "svc-a" });
    const b = governance.resolve({ spaceId: "svc-b" });

    a.provide(key, "a-value");
    expect(a.get(key)).toBe("a-value");
    expect(() => b.get(key)).toThrow();
    expect(b.sessionStore).toBe(sessions.get("svc-b"));
    expect(a.sessionStore).not.toBe(b.sessionStore);
    expect(a.durableEffects).toBe(effects.get("svc-a"));
    expect(a.durableEffects).not.toBe(b.durableEffects);
    expect(a.streamFn).toBe(streams.get("svc-a"));
    expect(a.streamFn).not.toBe(b.streamFn);
    expect(a.research).not.toBe(b.research);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.on("tenant-event", (payload) => seenA.push(payload));
    b.on("tenant-event", (payload) => seenB.push(payload));
    a.emit("tenant-event", "a");
    expect(seenA).toEqual(["a"]);
    expect(seenB).toEqual([]);
    b.emit("tenant-event", "b");
    expect(seenB).toEqual(["b"]);

    await governance.dispose();
  });

  test("子 realm dispose 不影响兄弟 realm", async () => {
    const governance = createTenantGovernance();
    const a = governance.resolve({ spaceId: "dispose-a" });
    const b = governance.resolve({ spaceId: "dispose-b" });
    const key = defineKey<string>("@zeta-agent/t13-agent", "dispose-resource");
    a.set(key, "a");
    b.set(key, "b");

    await governance.disposeRealm(a.realm);
    expect(() => a.get(key)).toThrow();
    expect(b.get(key)).toBe("b");
    expect(governance.scopes.has(a.realm)).toBe(false);
    expect(governance.scopes.has(b.realm)).toBe(true);

    await governance.dispose();
  });

  test("notify 不跨租户：只刷新目标 realm 的 fiber", async () => {
    const key = defineKey<string>("@zeta-agent/t13-agent", "notify-resource");
    const governance = createTenantGovernance();
    const a = governance.resolve({ spaceId: "notify-a" });
    const b = governance.resolve({ spaceId: "notify-b" });
    const seenA: string[] = [];
    const seenB: string[] = [];
    const reader = (seen: string[]) =>
      defineComponent({
        name: "scope-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });

    a.context.use(reader(seenA));
    b.context.use(reader(seenB));
    a.provide(key, "a1");
    await governance.notify(a.realm, [key]);
    expect(seenA).toEqual(["a1"]);
    expect(seenB).toEqual([]);

    b.provide(key, "b1");
    await governance.notify(b.realm, [key]);
    expect(seenB).toEqual(["b1"]);
    expect(seenA).toEqual(["a1"]);

    await governance.dispose();
  });

  test("配额按 realm 独立且并发 reserve 不超额", async () => {
    const governance = createTenantGovernance({ tokensPerTenant: 3 });
    const a = governance.resolve({ spaceId: "quota-a" });
    const b = governance.resolve({ spaceId: "quota-b" });
    const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve(a.quota.reserve(1))));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(a.quota.remaining()).toBe(0);
    expect(b.quota.remaining()).toBe(3);

    await governance.dispose();
  });

  test("realm churn：反复解析/回收不残留 scope，兄弟 realm 始终可用", async () => {
    const governance = createTenantGovernance();
    const stable = governance.resolve({ spaceId: "stable" });
    const key = defineKey<string>("@zeta-agent/t13-agent", "churn-resource");
    stable.set(key, "stable-value");

    for (let index = 0; index < 10; index += 1) {
      const space = `churn-${index}`;
      const scope = governance.resolve({ spaceId: space });
      scope.set(key, space);
      expect(scope.get(key)).toBe(space);
      await governance.disposeRealm(scope.realm);
      expect(governance.scopes.has(scope.realm)).toBe(false);
      expect(stable.get(key)).toBe("stable-value");
    }
    expect(governance.scopes.size).toBe(1);
    await governance.dispose();
  });
});
