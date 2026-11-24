import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "./types";
import type { Context } from "./index";
import {
  contribute,
  createContext,
  createView,
  defineComponent,
  defineKey,
  defineRegistry,
  notify,
  on,
  resolveRegistry,
  use,
  VERSION_MISMATCH,
} from "./index";

describe("framework facade 运行时", () => {
  test("defineKey 生成 @scope/name:key 命名空间且工厂可调用", () => {
    const key = defineKey<string>("@zeta-agent/context-test", "counter", { commutative: true });
    expect(key.namespace).toBe("@zeta-agent/context-test");
    expect(key.name).toBe("counter");
    expect(key.symbol.description).toBe("@zeta-agent/context-test:counter");
    expect(key.commutative).toBe(true);

    const qualified = defineKey<number>("@zeta-agent/context-test:plain");
    expect(qualified.namespace).toBe("@zeta-agent/context-test");
    expect(qualified.name).toBe("plain");

    const registry = defineRegistry<number, number>("sum", {
      compose: (items) => items.reduce((total, item) => total + item, 0),
      fallback: 0,
    });
    const undo = contribute(registry, 2);
    expect(resolveRegistry(registry)).toBe(2);
    undo();
    expect(resolveRegistry(registry)).toBe(0);
  });

  test("effect/get/set/isolate/intercept/on 均可用", async () => {
    const counter = defineKey<number>("@zeta-agent/context-test", "counter-local");
    const ctx = createContext();
    let effectDisposed = 0;
    ctx.effect(() => () => {
      effectDisposed += 1;
    });

    const undo = ctx.set(counter, 1);
    expect(ctx.get(counter)).toBe(1);

    const realm = Symbol("realm-a");
    const isolated = ctx.isolate(counter, realm);
    expect(() => isolated.get(counter)).toThrow("INACTIVE_ACCESS");
    const undoIsolated = isolated.set(counter, 2);
    expect(isolated.get(counter)).toBe(2);
    expect(ctx.get(counter)).toBe(1);
    undoIsolated();

    expect(ctx.intercept(counter, 5).get(counter)).toBe(1);
    expect(ctx.intercept(counter, (value: unknown) => (value as number) * 2).get(counter)).toBe(2);

    const seen: unknown[] = [];
    const off = ctx.on("ping", (payload) => seen.push(payload));
    ctx.emit("ping", "x");
    off();
    ctx.emit("ping", "y");
    expect(seen).toEqual(["x"]);

    undo();
    await ctx.dispose();
    expect(effectDisposed).toBe(1);
  });

  test("ctx.use 把 config 传入 component.apply（兼容 apply(ctx)）", async () => {
    const seen: string[] = [];
    const component = defineComponent<{ tag: string }>({
      name: "config-receiver",
      inject: [],
      provide: [],
      apply: (_ctx, config) => {
        seen.push(config.tag);
        return () => {};
      },
    });
    const ctx = createContext();
    const handle = use(ctx, component, { tag: "received" });
    await handle.ready;
    expect(seen).toEqual(["received"]);
    expect(handle.state.kind).toBe("ACTIVE");
    await ctx.dispose();
  });

  test("notify 触发依赖刷新", async () => {
    const value = defineKey<string>("@zeta-agent/context-test", "notify-value", { commutative: true });
    const seen: string[] = [];
    const reader = defineComponent({
      name: "notify-reader",
      inject: [value],
      provide: [],
      apply: (ctx) => {
        seen.push(ctx.get(value));
        return () => {};
      },
    });

    const ctx = createContext();
    const releaseV1 = ctx.provide(value, "v1");
    const handle = ctx.use(reader);
    await notify(ctx);
    expect(seen).toEqual(["v1"]);
    expect(handle.state.kind).toBe("ACTIVE");

    releaseV1();
    ctx.provide(value, "v2");
    await notify(ctx, [value]);
    expect(seen).toEqual(["v1", "v2"]);
    await ctx.dispose();
  });

  test("同配置不同注入顺序观察状态一致", async () => {
    const left = defineKey<string>("@zeta-agent/context-test", "left");
    const right = defineKey<string>("@zeta-agent/context-test", "right");

    function makeReader(key: CoeffectKey<string>, label: string, log: string[]) {
      return defineComponent<{ id: string }>({
        name: label,
        inject: [key],
        provide: [],
        apply: (ctx, config) => {
          log.push(`${label}:${config.id}:${ctx.get(key)}`);
          return () => {};
        },
      });
    }

    async function assemble(order: readonly ("left" | "right")[]) {
      const ctx = createContext();
      const log: string[] = [];
      const releases = [ctx.provide(left, "L"), ctx.provide(right, "R")];
      const components = {
        left: makeReader(left, "left", log),
        right: makeReader(right, "right", log),
      };
      const handles = order.map((name) => ctx.use(components[name], { id: "cfg" }));
      await ctx.notify();
      const result = {
        values: [ctx.get(left), ctx.get(right)],
        states: handles.map((handle) => handle.state.kind).sort(),
        log: [...log].sort(),
      };
      handles.forEach((handle) => handle.remove());
      releases.forEach((release) => void release());
      await ctx.dispose();
      return result;
    }

    const forward = await assemble(["left", "right"]);
    const reversed = await assemble(["right", "left"]);
    expect(forward).toEqual(reversed);
    expect(forward.values).toEqual(["L", "R"]);
    expect(forward.states).toEqual(["ACTIVE", "ACTIVE"]);
  });

  test("G02/G04 provider 撤销后经 production committed view 抛 CAPABILITY_EXPIRED", async () => {
    const cap = defineKey<string>("@zeta-agent/context-test", "revocable-cap");
    const ctx = createContext();
    const revoke = ctx.provide(cap, "secret");
    expect(ctx.get(cap)).toBe("secret");

    revoke();
    // STORE 已恢复为空；只能由 production 写入的 node.committed 提供 Impl，
    // 其 check 因 provider 撤销返回 false → CAPABILITY_EXPIRED（而非 INACTIVE_ACCESS）。
    expect(() => ctx.get(cap)).toThrow("CAPABILITY_EXPIRED");
    await ctx.dispose();
  });

  test("G04 facade Proxy 门禁：已声明键按 committed view 解析，未声明键被拒", async () => {
    const declared = defineKey<string>("@zeta-agent/context-test", "proxy-declared");
    const undeclared = defineKey<string>("@zeta-agent/context-test", "proxy-undeclared");
    const ctx = createContext();
    ctx.provide(declared, "visible");

    const view = createView<{ [k: symbol]: unknown }>(ctx);
    expect(view[declared.symbol]).toBe("visible");
    expect(() => view[undeclared.symbol]).toThrow("UNDECLARED_ACCESS");

    const viaCtx = ctx.proxy<{ [k: symbol]: unknown }>();
    expect(viaCtx[declared.symbol]).toBe("visible");
    await ctx.dispose();
  });

  test("G01 defineComponent 保留 accepts 版本映射", () => {
    const component = defineComponent<unknown>({
      name: "versioned",
      accepts: { "@zeta-agent/context-test:svc": "1.0" },
      apply: () => () => {},
    });
    expect(component.accepts).toEqual({ "@zeta-agent/context-test:svc": "1.0" });
  });

  test("G01 accepts 匹配时消费者 ACTIVE，不匹配时 FAILED 且不执行 apply", async () => {
    const svc = defineKey<string>("@zeta-agent/context-test", "accepts-svc");
    const provider = defineComponent<string>({
      name: "provider-v1",
      version: "1.0",
      inject: [],
      provide: [svc],
      apply: () => () => {},
    });
    const applied: string[] = [];
    const consumer = (accepted: string) =>
      defineComponent({
        name: `consumer-${accepted}`,
        inject: [svc],
        provide: [],
        accepts: { [svc.symbol.description ?? svc.name]: accepted },
        apply: () => {
          applied.push(accepted);
          return () => {};
        },
      });

    const ctxOk = createContext();
    ctxOk.use(provider);
    const ok = ctxOk.use(consumer("1.0"));
    await ctxOk.notify();
    await ok.ready;
    expect(ok.state.kind).toBe("ACTIVE");
    expect(applied).toEqual(["1.0"]);
    await ctxOk.dispose();

    const ctxBad = createContext();
    ctxBad.use(provider);
    const bad = ctxBad.use(consumer("2.0"));
    await ctxBad.notify();
    await bad.ready;
    expect(bad.state.kind).toBe("FAILED");
    if (bad.state.kind === "FAILED") {
      expect((bad.state.error as Error).message).toContain(VERSION_MISMATCH);
    }
    expect(applied).toEqual(["1.0"]);
    await ctxBad.dispose();
  });

  test("G01 accepts 支持短键名，未声明 accepts 的消费者不做校验", async () => {
    const svc = defineKey<string>("@zeta-agent/context-test", "accepts-short-name");
    const ctx = createContext();
    ctx.use(
      defineComponent({
        name: "provider-v3",
        version: "3",
        inject: [],
        provide: [svc],
        apply: () => () => {},
      })
    );
    const applied: string[] = [];
    const byShortName = ctx.use(
      defineComponent({
        name: "consumer-short",
        inject: [svc],
        provide: [],
        accepts: { [svc.name]: "3" },
        apply: () => {
          applied.push("short");
          return () => {};
        },
      })
    );
    const unversioned = ctx.use(
      defineComponent({
        name: "consumer-none",
        inject: [svc],
        provide: [],
        apply: () => {
          applied.push("none");
          return () => {};
        },
      })
    );
    await ctx.notify();
    expect(byShortName.state.kind).toBe("ACTIVE");
    expect(unversioned.state.kind).toBe("ACTIVE");
    expect(applied.sort()).toEqual(["none", "short"]);
    await ctx.dispose();
  });

  test("G08 facade 导出 on：函数式入口等价于 ctx.on", () => {
    const ctx = createContext();
    const seen: unknown[] = [];
    const off = on(ctx, "facade-on", (payload) => seen.push(payload));
    ctx.emit("facade-on", 1);
    off();
    ctx.emit("facade-on", 2);
    expect(seen).toEqual([1]);
  });
});

describe("A28 多租户 realm 隔离", () => {
  test("per-tenant 资源经 realm 解析：同键不同 realm 互不覆盖", async () => {
    const resource = defineKey<string>("@zeta-agent/context-test", "tenant-resource");
    const ctx = createContext();
    const tenantA = ctx.isolate(resource, Symbol("tenant-a"));
    const tenantB = ctx.isolate(resource, Symbol("tenant-b"));

    const releaseA = tenantA.set(resource, "db://tenant-a");
    const releaseB = tenantB.set(resource, "db://tenant-b");

    expect(tenantA.get(resource)).toBe("db://tenant-a");
    expect(tenantB.get(resource)).toBe("db://tenant-b");
    // 根 context 未声明该租户键：连读取入口都不存在，不会串到其他租户。
    expect(() => ctx.get(resource)).toThrow("UNDECLARED_ACCESS");

    releaseA();
    expect(() => tenantA.get(resource)).toThrow("INACTIVE_ACCESS");
    expect(tenantB.get(resource)).toBe("db://tenant-b");
    releaseB();
    await ctx.dispose();
  });

  test("跨租户事件不串：一个租户的 emit 不触达另一个租户的 listener", async () => {
    const tenantA = createContext({ uid: "tenant-a" });
    const tenantB = createContext({ uid: "tenant-b" });
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    tenantA.on("tenant-event", (payload) => seenA.push(payload));
    tenantB.on("tenant-event", (payload) => seenB.push(payload));
    tenantA.emit("tenant-event", { from: "a" });

    expect(seenA).toEqual([{ from: "a" }]);
    expect(seenB).toEqual([]);

    tenantB.emit("tenant-event", { from: "b" });
    expect(seenA).toEqual([{ from: "a" }]);
    expect(seenB).toEqual([{ from: "b" }]);
    await tenantA.dispose();
    await tenantB.dispose();
  });

  test("配额作为 coeffect 可 reserve：各 realm 独立扣减且超额失败", async () => {
    interface QuotaService {
      check(tool: string): boolean;
      reserve(tokens: number): boolean;
      remaining(): number;
    }
    const quotaKey = defineKey<QuotaService>("@zeta-agent/context-test", "tenant-quota");
    const ctx = createContext();

    function tenantQuota(realm: symbol, capacity: number) {
      const scope = ctx.isolate(quotaKey, realm);
      let used = 0;
      const service: QuotaService = {
        check: (tool) => tool.length > 0 && used < capacity,
        reserve: (tokens) => {
          if (!Number.isInteger(tokens) || tokens <= 0 || used + tokens > capacity) return false;
          used += tokens;
          return true;
        },
        remaining: () => capacity - used,
      };
      const release = scope.set(quotaKey, service);
      return { scope, service, release };
    }

    const a = tenantQuota(Symbol("quota-a"), 3);
    const b = tenantQuota(Symbol("quota-b"), 1);

    expect(a.scope.get(quotaKey).check("shell")).toBe(true);
    expect(a.scope.get(quotaKey).reserve(2)).toBe(true);
    expect(a.scope.get(quotaKey).remaining()).toBe(1);
    expect(a.scope.get(quotaKey).reserve(2)).toBe(false);
    // 另一租户的配额不受影响。
    expect(b.scope.get(quotaKey).remaining()).toBe(1);
    expect(b.scope.get(quotaKey).reserve(1)).toBe(true);
    expect(b.scope.get(quotaKey).reserve(1)).toBe(false);

    a.release();
    b.release();
    await ctx.dispose();
  });
});

describe("A28 严格 realm 事件隔离", () => {
  const evKeyA = defineKey<string>("@zeta-agent/context-test", "strict-realm-a");
  const evKeyB = defineKey<string>("@zeta-agent/context-test", "strict-realm-b");

  test("两个 isolate 派生 context 的同名事件互不可达", async () => {
    const root: Context = createContext({ uid: "strict-root-1" });
    const a = root.isolate(evKeyA, Symbol("strict-a")) as Context;
    const b = root.isolate(evKeyB, Symbol("strict-b")) as Context;
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    a.on("strict-event", (p) => seenA.push(p));
    b.on("strict-event", (p) => seenB.push(p));
    a.emit("strict-event", "from-a");
    expect(seenA).toEqual(["from-a"]);
    expect(seenB).toEqual([]);
    b.emit("strict-event", "from-b");
    expect(seenA).toEqual(["from-a"]);
    expect(seenB).toEqual(["from-b"]);
    await root.dispose();
  });

  test("显式相同 realm 的派生 context 之间事件互通", async () => {
    const root: Context = createContext({ uid: "strict-root-2" });
    const realm = Symbol("shared-realm");
    const a = root.isolate(evKeyA, realm) as Context;
    const b = root.isolate(evKeyB, realm) as Context;
    const seen: unknown[] = [];

    a.on("shared-event", (p) => seen.push(p));
    b.on("shared-event", (p) => seen.push(p));
    a.emit("shared-event", 1);
    b.emit("shared-event", 2);
    // 同 realm 下两个派生 context 互通：每次 emit 都被两个监听器各收到一次。
    expect(seen).toEqual([1, 1, 2, 2]);
    await root.dispose();
  });

  test("root 与派生 realm 的事件方向性：互不串扰", async () => {
    const root: Context = createContext({ uid: "strict-root-3" });
    const child = root.isolate(evKeyA, Symbol("child-realm")) as Context;
    const rootSeen: unknown[] = [];
    const childSeen: unknown[] = [];

    root.on("dir-event", (p) => rootSeen.push(p));
    child.on("dir-event", (p) => childSeen.push(p));
    root.emit("dir-event", "root");
    child.emit("dir-event", "child");
    expect(rootSeen).toEqual(["root"]);
    expect(childSeen).toEqual(["child"]);
    await root.dispose();
  });

  test("on 返回的 disposer 幂等且只移除自己的监听", async () => {
    const root: Context = createContext({ uid: "strict-root-4" });
    const a = root.isolate(evKeyA, Symbol("disp-a")) as Context;
    const seen: string[] = [];

    const stopA = a.on("disp-event", (p) => seen.push(`a:${String(p)}`));
    a.on("disp-event", (p) => seen.push(`a2:${String(p)}`));
    stopA();
    stopA();
    a.emit("disp-event", "x");
    expect(seen).toEqual(["a2:x"]);
    await root.dispose();
  });

  test("派生 context dispose 只清理本 realm 监听", async () => {
    const root: Context = createContext({ uid: "strict-root-5" });
    const a = root.isolate(evKeyA, Symbol("clean-realm")) as Context;
    const rootSeen: unknown[] = [];
    const aSeen: unknown[] = [];

    root.on("clean-event", (p) => rootSeen.push(p));
    a.on("clean-event", (p) => aSeen.push(p));
    await a.dispose();
    a.emit("clean-event", "after");
    root.emit("clean-event", "root-alive");
    expect(aSeen).toEqual([]);
    expect(rootSeen).toEqual(["root-alive"]);
    await root.dispose();
  });

  test("intercept 派生 context 继承父 realm，事件互通", async () => {
    const root: Context = createContext({ uid: "strict-root-6" });
    const child = root.intercept(evKeyA, (v: unknown) => v) as Context;
    const seen: unknown[] = [];

    root.on("intercept-event", (p) => seen.push(p));
    child.on("intercept-event", (p) => seen.push(p));
    root.emit("intercept-event", 1);
    expect(seen).toEqual([1, 1]);
    await root.dispose();
  });

  test("realm 资源隔离与事件隔离组合不串", async () => {
    const root: Context = createContext({ uid: "strict-root-7" });
    const res = defineKey<string>("@zeta-agent/context-test", "strict-resource");
    const a = root.isolate(res, Symbol("combo-a")) as Context;
    const b = root.isolate(res, Symbol("combo-b")) as Context;
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    a.on("combo-event", (p) => seenA.push(p));
    b.on("combo-event", (p) => seenB.push(p));
    a.set(res, "a-resource");
    b.set(res, "b-resource");
    a.emit("combo-event", "a");
    expect(a.get(res)).toBe("a-resource");
    expect(b.get(res)).toBe("b-resource");
    expect(seenA).toEqual(["a"]);
    expect(seenB).toEqual([]);
    await root.dispose();
  });
});
