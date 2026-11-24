import { describe, expect, test } from "bun:test";
import { createContext, defineComponent, defineKey, type Context } from "./index";

describe("T-13 realm 强隔离生命周期", () => {
  test("Context 暴露 realm，派生 realm 与根及兄弟均不同", async () => {
    const root = createContext({ uid: "t13-realm-root" });
    const key = defineKey<string>("@zeta-agent/t13", "realm-identity");
    const a = root.isolate(key, Symbol("t13-identity-a")) as Context;
    const b = root.isolate(key, Symbol("t13-identity-b")) as Context;

    expect(typeof root.realm).toBe("symbol");
    expect(a.realm).not.toBe(root.realm);
    expect(b.realm).not.toBe(root.realm);
    expect(a.realm).not.toBe(b.realm);

    await root.dispose();
  });

  test("派生 realm 的 notify/provider 变更不触达兄弟 realm", async () => {
    const key = defineKey<string>("@zeta-agent/t13", "notify-resource");
    const root = createContext({ uid: "t13-notify-root" });
    const a = root.isolate(key, Symbol("t13-notify-a")) as Context;
    const b = root.isolate(key, Symbol("t13-notify-b")) as Context;

    const seenA: string[] = [];
    const seenB: string[] = [];
    const reader = (seen: string[]) =>
      defineComponent({
        name: "notify-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });

    const fiberA = a.use(reader(seenA));
    const fiberB = b.use(reader(seenB));
    const releaseA = a.provide(key, "a1");
    const releaseB = b.provide(key, "b1");
    await Promise.all([a.notify([key]), b.notify([key])]);
    expect(seenA).toEqual(["a1"]);
    expect(seenB).toEqual(["b1"]);

    // 只变更 A 的 provider：notify 绑定 realm，B 的 committed view 不得被重算。
    releaseA();
    a.provide(key, "a2");
    await a.notify([key]);
    expect(seenA).toEqual(["a1", "a2"]);
    expect(seenB).toEqual(["b1"]);
    expect(b.get(key)).toBe("b1");

    releaseA();
    releaseB();
    await root.dispose();
  });

  test("子 realm dispose 回收本 realm 资源，兄弟 realm 仍完整可用", async () => {
    const key = defineKey<string>("@zeta-agent/t13", "dispose-resource");
    const root = createContext({ uid: "t13-dispose-root" });
    const a = root.isolate(key, Symbol("t13-dispose-a")) as Context;
    const b = root.isolate(key, Symbol("t13-dispose-b")) as Context;
    const rootSeen: string[] = [];
    const aSeen: string[] = [];
    const bSeen: string[] = [];

    a.set(key, "a-resource");
    b.set(key, "b-resource");
    root.on("t13-event", (payload) => rootSeen.push(String(payload)));
    a.on("t13-event", (payload) => aSeen.push(String(payload)));
    b.on("t13-event", (payload) => bSeen.push(String(payload)));

    await a.dispose();
    expect(() => a.get(key)).toThrow("INACTIVE_ACCESS");
    expect(b.get(key)).toBe("b-resource");
    a.emit("t13-event", "after-dispose");
    b.emit("t13-event", "b-alive");
    root.emit("t13-event", "root-alive");
    expect(aSeen).toEqual([]);
    expect(bSeen).toEqual(["b-alive"]);
    expect(rootSeen).toEqual(["root-alive"]);

    await root.dispose();
  });

  test("effect 按 realm 独立宿主：dispose 子 realm 不回收兄弟 effect", async () => {
    const key = defineKey<string>("@zeta-agent/t13", "effect-realm");
    const root = createContext({ uid: "t13-effect-root" });
    const a = root.isolate(key, Symbol("t13-effect-a")) as Context;
    const b = root.isolate(key, Symbol("t13-effect-b")) as Context;
    let disposedA = 0;
    let disposedB = 0;

    a.effect(() => () => {
      disposedA += 1;
    });
    b.effect(() => () => {
      disposedB += 1;
    });

    await a.dispose();
    expect(disposedA).toBe(1);
    expect(disposedB).toBe(0);
    await root.dispose();
    expect(disposedB).toBe(1);
  });

  test("intercept 派生 context dispose 不卸掉父 realm 的 fiber", async () => {
    const key = defineKey<string>("@zeta-agent/t13", "intercept-owner");
    const root = createContext({ uid: "t13-intercept-owner" });
    const seen: string[] = [];
    root.use(
      defineComponent({
        name: "root-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      })
    );
    root.provide(key, "root");
    await root.notify([key]);
    expect(seen).toEqual(["root"]);

    const child = root.intercept(key, (value: unknown) => value) as Context;
    await child.dispose();
    expect(root.get(key)).toBe("root");
    await root.notify([key]);
    expect(seen).toEqual(["root"]);
    await root.dispose();
  });

  test("双租户并发：同名 provider/event/resource 在不同 realm 互不串", async () => {
    const key = defineKey<string>("@zeta-agent/t13", "concurrent-resource");
    const root = createContext({ uid: "t13-concurrent-root" });
    const a = root.isolate(key, Symbol("t13-concurrent-a")) as Context;
    const b = root.isolate(key, Symbol("t13-concurrent-b")) as Context;
    const seenA: string[] = [];
    const seenB: string[] = [];

    const reader = (seen: string[]) =>
      defineComponent({
        name: "concurrent-reader",
        inject: [key],
        provide: [],
        apply: (ctx) => {
          seen.push(ctx.get(key));
          return () => {};
        },
      });

    const releaseA = a.provide(key, "db://a");
    const releaseB = b.provide(key, "db://b");
    const fa = a.use(reader(seenA));
    const fb = b.use(reader(seenB));
    a.on("concurrent", (payload) => seenA.push(String(payload)));
    b.on("concurrent", (payload) => seenB.push(String(payload)));

    await Promise.all([a.notify([key]), b.notify([key])]);
    a.emit("concurrent", "from-a");
    b.emit("concurrent", "from-b");

    expect(seenA).toEqual(["db://a", "from-a"]);
    expect(seenB).toEqual(["db://b", "from-b"]);
    expect(a.get(key)).toBe("db://a");
    expect(b.get(key)).toBe("db://b");

    releaseA();
    releaseB();
    await root.dispose();
  });
});
