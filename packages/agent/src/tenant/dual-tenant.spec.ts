import { describe, expect, test } from "bun:test";
import {
  createJobRunner,
  createRollout,
  defineComponent,
  defineContract,
  defineFacet,
  defineKey,
  grantFor,
  openStore,
  type Context,
  type JobRunner,
  type RolloutController,
  type Store,
} from "@zeta-agent/framework";
import { quotaKey, realmForSpace } from "@zeta-agent/capabilities";
import { createDurableEffects, type DurableEffects } from "../plugins/effects/durable";
import { createExperienceStore } from "../research/experience";
import type { SessionStore } from "../session/store";
import type { AgentStreamFn } from "../facade";
import { createTenantGovernance } from "./governance";

const freshResearch = () => createExperienceStore();

function stubSession(spaceId: string): SessionStore {
  return { sessionId: spaceId, close: () => {} } as unknown as SessionStore;
}

function stubEffects(spaceId: string): DurableEffects {
  return createDurableEffects(() => spaceId);
}

const Service = defineContract({
  name: "t15.service",
  version: "1",
  params: {},
  members: { value: "value" },
});

describe("T-15 双租户 realm 渗透测试", () => {
  test("host/store/jobs/rollout/session/effects/stream/research/quota 按 realm 独立，跨 realm 调用与 notify 被拒", async () => {
    const governance = createTenantGovernance({
      tokensPerTenant: 2,
      createExperienceStore: freshResearch,
      createSessionStore: (principal) => stubSession(principal.spaceId),
      createDurableEffects: (principal) => stubEffects(principal.spaceId),
      createStreamFn: (principal) => (async function* (): AsyncIterable<string> {
        yield principal.spaceId;
      }) as unknown as AgentStreamFn,
      createObjectStore: () => openStore(),
      createObjectJobs: (principal) => createJobRunner({ handler: () => principal.spaceId, generation: 1 }),
      createObjectRollout: (principal) => createRollout({ hosts: [principal.spaceId], initialGeneration: 1 }),
    });
    const a = governance.resolve({ spaceId: "r-a", userId: "u-a" });
    const b = governance.resolve({ spaceId: "r-b", userId: "u-b" });

    expect(a.realm).not.toBe(b.realm);
    expect(a.objectHost).not.toBe(b.objectHost);
    expect(a.objectStore).not.toBe(b.objectStore);
    expect(a.objectJobs).not.toBe(b.objectJobs);
    expect(a.objectRollout).not.toBe(b.objectRollout);
    expect(a.sessionStore).not.toBe(b.sessionStore);
    expect(a.durableEffects).not.toBe(b.durableEffects);
    expect(a.streamFn).not.toBe(b.streamFn);
    expect(a.research).not.toBe(b.research);

    // 配额以 coeffect key 按 realm provide；预算互不共享。
    expect(a.get(quotaKey)).toBe(a.quota);
    expect(b.get(quotaKey)).toBe(b.quota);
    expect(a.get(quotaKey)).not.toBe(b.get(quotaKey));
    expect(a.quota.reserve({ tool: "shell", tokens: 2 })).toBe(true);
    expect(a.quota.reserve({ tool: "shell", tokens: 1 })).toBe(false);
    expect(b.quota.remaining()).toBe(2);

    // host 实例身份绑定 realm/principal/space：同契约双 realm 各自 live，跨 realm grant 被拒。
    const facet = defineFacet((host) => {
      host.serve(Service, () => ({ value: "ok" }));
    });
    await a.objectHost.load([{ name: "svc", facet }]);
    await b.objectHost.load([{ name: "svc", facet }]);
    const grantA = grantFor({ userId: "u-a", spaceId: "r-a", realm: a.realm }, [Service.name]);
    const grantB = grantFor({ userId: "u-b", spaceId: "r-b", realm: b.realm }, [Service.name]);
    const fromA = await a.objectHost.get(Service, undefined, {
      principal: { userId: "u-a", spaceId: "r-a", realm: a.realm },
      grant: grantA,
    });
    const fromB = await b.objectHost.get(Service, undefined, {
      principal: { userId: "u-b", spaceId: "r-b", realm: b.realm },
      grant: grantB,
    });
    await Promise.all([fromA.ready, fromB.ready]);
    expect(fromA.state).toBe("live");
    expect(fromB.state).toBe("live");
    // 在 B 的 host 上用 A 的 grant 调用：realm 不匹配必须失败关闭。
    const breach = await b.objectHost.get(Service, undefined, {
      principal: { userId: "u-b", spaceId: "r-b", realm: b.realm },
      grant: grantA,
    });
    expect(breach.state).toBe("denied");

    // 事件与 fiber notify 只在目标 realm 触达，兄弟 realm 不串。
    const key = defineKey<string>("@zeta-agent/t15", "realm-resource");
    const seenA: string[] = [];
    const seenB: string[] = [];
    const reader = (seen: string[]) =>
      defineComponent({
        name: "t15-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });
    a.context.use(reader(seenA));
    b.context.use(reader(seenB));
    a.provide(key, "a-only");
    await governance.notify(a.realm, [key]);
    expect(seenA).toEqual(["a-only"]);
    expect(seenB).toEqual([]);
    b.provide(key, "b-only");
    await governance.notify(b.realm, [key]);
    expect(seenB).toEqual(["b-only"]);
    expect(seenA).toEqual(["a-only"]);

    await governance.disposeRealm(a.realm);
    expect(governance.scopes.has(a.realm)).toBe(false);
    expect(governance.scopes.has(b.realm)).toBe(true);
    expect(b.get(quotaKey)).toBe(b.quota);
    await governance.dispose();
  });

  test("缺 origin 与缺 per-realm 工厂均显式拒绝，不用共享回退蒙混", () => {
    const noFactory = createTenantGovernance();
    expect(() => noFactory.resolve({})).toThrow("TENANT_ORIGIN_REQUIRED");
    expect(() => noFactory.resolve({ spaceId: "only-principal" })).toThrow("TENANT_FACTORY_REQUIRED");

    // 自定义 resolver 也不能绕过 origin 门禁。
    const custom = createTenantGovernance({
      createExperienceStore: freshResearch,
      resolver: () => ({ userId: "u", spaceId: "custom", realm: realmForSpace("custom") }),
    });
    expect(() => custom.resolve({})).toThrow("TENANT_ORIGIN_REQUIRED");
    return Promise.all([noFactory.dispose(), custom.dispose()]);
  });

  test("显式单租户模式真实可用：缺省 origin/research 可用但不创建共享实例", async () => {
    const governance = createTenantGovernance({ mode: "single-tenant" });
    const first = governance.resolve();
    const second = governance.resolve();
    expect(first).toBe(second);
    expect(first.principal.spaceId).toBe("default");
    expect(first.research).toBeDefined();
    expect(first.get(quotaKey)).toBe(first.quota);
    await governance.dispose();
  });

  test("providerVersions 按 realm 分区：兄弟 realm 的 provider 版本不串", async () => {
    const key = defineKey<string>("@zeta-agent/t15", "versioned-service");
    const governance = createTenantGovernance({ createExperienceStore: freshResearch });
    const a = governance.resolve({ spaceId: "pv-a" });
    const b = governance.resolve({ spaceId: "pv-b" });
    const seenA: string[] = [];
    const seenB: string[] = [];
    const description = key.symbol.description ?? key.name;
    const provider = (version: string, value: string) =>
      defineComponent({
        name: `provider-${version}`,
        version,
        inject: [],
        provide: [key],
        apply: (ctx) => {
          ctx.provide(key, value);
          return () => {};
        },
      });
    const consumer = (version: string, seen: string[]) =>
      defineComponent({
        name: `consumer-${version}`,
        version,
        inject: [key],
        provide: [],
        accepts: { [description]: version },
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });

    a.context.use(provider("1", "v1"));
    b.context.use(provider("2", "v2"));
    const fiberA = a.context.use(consumer("1", seenA));
    const fiberB = b.context.use(consumer("2", seenB));
    await Promise.all([fiberA.ready, fiberB.ready, a.notify(), b.notify()]);
    expect(seenA).toEqual(["v1"]);
    expect(seenB).toEqual(["v2"]);
    await governance.dispose();
  });

  test("子 context notify 只刷新目标 realm 的 fiber", async () => {
    const key = defineKey<string>("@zeta-agent/t15", "child-resource");
    const governance = createTenantGovernance({ createExperienceStore: freshResearch });
    const scope = governance.resolve({ spaceId: "child-parent" });
    const childA = scope.context.isolate(key, Symbol("child-realm-a")) as Context;
    const childB = scope.context.isolate(key, Symbol("child-realm-b")) as Context;
    const seenA: string[] = [];
    const seenB: string[] = [];
    const reader = (seen: string[]) =>
      defineComponent({
        name: "child-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });

    // 只在 A 的子 realm provide，notify A 后不得触达兄弟子 realm 的 reader。
    childA.use(reader(seenA));
    childB.use(reader(seenB));
    childA.provide(key, "a-only");
    await childA.notify([key]);
    expect(seenA).toEqual(["a-only"]);
    expect(seenB).toEqual([]);
    childB.provide(key, "b-only");
    await childB.notify([key]);
    expect(seenB).toEqual(["b-only"]);
    expect(seenA).toEqual(["a-only"]);
    await governance.dispose();
  });

  test("qps 按 realm 独立且按秒窗复位；工具名/token 成本经 coeffect 生效", async () => {
    let now = 1_000_000;
    const governance = createTenantGovernance({
      tokensPerTenant: 8,
      qpsPerTenant: 1,
      quotaClock: () => now,
      toolCosts: { shell: 3 },
      createExperienceStore: freshResearch,
    });
    const a = governance.resolve({ spaceId: "qps-a" });
    const b = governance.resolve({ spaceId: "qps-b" });
    const quotaA = a.get(quotaKey);
    const quotaB = b.get(quotaKey);

    expect(quotaA.qps).toBe(1);
    expect(quotaA.check({ tool: "shell", tokens: 3 })).toBe(true);
    expect(quotaA.reserve({ tool: "shell", tokens: 3 })).toBe(true);
    expect(quotaA.remaining()).toBe(5);
    expect(quotaA.reserve({ tool: "shell", tokens: 1 })).toBe(false); // qps 命中上限
    expect(quotaB.check({ tool: "shell", tokens: 3 })).toBe(true);
    expect(quotaB.reserve({ tool: "shell", tokens: 3 })).toBe(true);
    expect(quotaB.qpsRemaining()).toBe(0);

    now += 1000;
    expect(quotaA.qpsRemaining()).toBe(1);
    expect(quotaA.reserve({ tool: "shell", tokens: 1 })).toBe(true);
    expect(quotaA.remaining()).toBe(4);
    await governance.dispose();
  });

  test("同 realm 换绑 principal 被拒，避免跨用户复用 scope/host", async () => {
    const governance = createTenantGovernance({ createExperienceStore: freshResearch });
    governance.resolve({ spaceId: "bind", userId: "owner" });
    expect(() => governance.resolve({ spaceId: "bind", userId: "intruder" })).toThrow(
      "TENANT_PRINCIPAL_MISMATCH"
    );
    await governance.dispose();
  });
});
