import { describe, expect, test } from "bun:test";
import {
  createContext,
  defineComponent,
  defineKey,
  type Context,
  type EffectMeta,
  type EffectObserver,
} from "./index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("T-05 fiber 生命周期", () => {
  test("fiber effect 归属独立，remove/update/dispose 逆各一次", async () => {
    const calls: string[] = [];
    let generation = 0;
    const ctx = createContext();
    const handle = ctx.use(
      defineComponent({
        name: "owned-effects",
        apply: (fiber) => {
          const current = ++generation;
          fiber.effect(() => () => {
            calls.push(`first-${current}`);
          });
          fiber.effect(() => () => {
            calls.push(`second-${current}`);
          });
          return () => {
            calls.push(`apply-${current}`);
          };
        },
      })
    );
    await handle.ready;
    await handle.update();
    expect(calls).toEqual(["apply-1", "second-1", "first-1"]);
    handle.remove();
    await ctx.notify();
    await ctx.dispose();
    handle.remove();
    expect(calls).toEqual(["apply-1", "second-1", "first-1", "apply-2", "second-2", "first-2"]);
  });

  test("ctx.use 子 fiber 在父 update 时退役并以新 uid 重建", async () => {
    const calls: string[] = [];
    const uids: string[] = [];
    const childReady: Array<Promise<void>> = [];
    let generation = 0;
    const ctx = createContext();
    const child = defineComponent({
      name: "retired-child",
      apply: () => {
        const current = ++generation;
        return () => {
          calls.push(`child-${current}`);
        };
      },
    });
    const parent = ctx.use(
      defineComponent({
        name: "retiring-parent",
        apply: (fiber) => {
          const handle = (fiber as Context).use(child);
          uids.push(handle.uid);
          childReady.push(handle.ready);
          return () => {};
        },
      })
    );
    await parent.ready;
    await Promise.all(childReady);
    expect(generation).toBe(1);
    expect(calls).toEqual([]);

    await parent.update();
    await Promise.all(childReady);
    expect(new Set(uids).size).toBe(2);
    expect(uids[0]).not.toBe(uids[1]);
    expect(calls).toEqual(["child-1"]);

    parent.remove();
    await ctx.notify();
    await ctx.dispose();
    expect(calls).toEqual(["child-1", "child-2"]);
  });

  test("provider 撤回等待 consumer teardown，且 teardown 可读旧依赖", async () => {
    const dependency = defineKey<string>("@zeta-agent/lifecycle-test", "guard-dependency");
    const service = defineKey<string>("@zeta-agent/lifecycle-test", "guard-service");
    const consumerGate = deferred();
    const events: string[] = [];
    const ctx = createContext();
    const releaseDependency = ctx.provide(dependency, "old-dependency");
    const provider = ctx.use(
      defineComponent({
        name: "guarded-provider",
        inject: [dependency],
        provide: [service],
        apply: (fiber) => {
          fiber.provide(service, "service");
          return async () => {
            events.push(`provider:${fiber.get(dependency)}`);
          };
        },
      })
    );
    const consumer = ctx.use(
      defineComponent({
        name: "guarded-consumer",
        inject: [service],
        apply: (fiber) => async () => {
          events.push(`consumer:${fiber.get(service)}`);
          await consumerGate.promise;
          events.push("consumer:done");
        },
      })
    );
    await provider.ready;
    await consumer.ready;
    await ctx.notify();

    releaseDependency();
    await until(() => provider.state.kind === "UNLOADING" && consumer.state.kind === "UNLOADING");
    expect(events).toEqual(["consumer:service"]);
    consumerGate.resolve();
    await ctx.notify([dependency]);
    expect(events).toEqual(["consumer:service", "consumer:done", "provider:old-dependency"]);
    expect(provider.state.kind).toBe("PENDING");
    expect(consumer.state.kind).toBe("PENDING");
    await ctx.dispose();
  });

  test("兄弟 realm 的 provider 与 consumer 不受撤销影响", async () => {
    const service = defineKey<string>("@zeta-agent/lifecycle-test", "realm-guard");
    const root = createContext();
    const a = root.isolate(service, Symbol("lifecycle-a"));
    const b = root.isolate(service, Symbol("lifecycle-b"));
    const releaseA = a.provide(service, "a");
    const releaseB = b.provide(service, "b");
    const seenB: string[] = [];
    const consumerB = (b as Context).use(
      defineComponent({
        name: "realm-b-consumer",
        inject: [service],
        apply: (fiber) => {
          seenB.push(fiber.get(service));
          return () => {};
        },
      })
    );
    await root.notify([service]);
    expect(consumerB.state.kind).toBe("ACTIVE");

    releaseA();
    await root.notify([service]);
    expect(consumerB.state.kind).toBe("ACTIVE");
    expect(b.get(service)).toBe("b");
    expect(seenB).toEqual(["b"]);
    releaseB();
    await root.dispose();
  });

  test("teardown 全部尝试并聚合错误", async () => {
    const calls: string[] = [];
    const ctx = createContext();
    const handle = ctx.use(
      defineComponent({
        name: "failing-teardowns",
        apply: (fiber) => {
          fiber.effect(() => () => {
            calls.push("first");
            throw new Error("first failed");
          });
          fiber.effect(() => () => {
            calls.push("second");
            throw new Error("second failed");
          });
          return () => {};
        },
      })
    );
    await handle.ready;
    let error: unknown;
    try {
      await ctx.dispose();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(calls.sort()).toEqual(["first", "second"]);
  });

  test("notify 只刷新声明目标 key 的 fiber", async () => {
    const aKey = defineKey<string>("@zeta-agent/lifecycle-test", "notify-a");
    const bKey = defineKey<string>("@zeta-agent/lifecycle-test", "notify-b");
    const loads = { a: 0, b: 0 };
    const ctx = createContext();
    ctx.provide(aKey, "a");
    ctx.provide(bKey, "b");
    const make = (key: typeof aKey, name: "a" | "b") =>
      defineComponent({
        name: `notify-${name}`,
        inject: [key],
        apply: () => {
          loads[name] += 1;
          return () => {};
        },
      });
    const a = ctx.use(make(aKey, "a"));
    const b = ctx.use(make(bKey, "b"));
    await ctx.notify();
    expect(loads).toEqual({ a: 1, b: 1 });
    await ctx.notify([aKey]);
    expect(loads).toEqual({ a: 1, b: 1 });
    expect(a.state.kind).toBe("ACTIVE");
    expect(b.state.kind).toBe("ACTIVE");
    await ctx.dispose();
  });

  test("异步 iterator 取消时调用 return()", async () => {
    const { createEffectHost, effect } = await import("@zeta-agent/cordis");
    const waiting = deferred();
    const release = deferred();
    let returned = false;
    let acquired = 0;
    const host = createEffectHost("iterator-cancel");
    const dispose = effect(host, async function* () {
      try {
        yield () => {
          acquired += 1;
        };
        waiting.resolve();
        await release.promise;
        yield () => {
          acquired += 1;
        };
      } finally {
        returned = true;
      }
    });
    await waiting.promise;
    const disposing = dispose();
    release.resolve();
    await disposing;
    expect(returned).toBe(true);
    expect(acquired).toBe(2);
  });

  test("drain timeout 给出未静止 fiber 诊断", async () => {
    const { FiberSystem } = await import("@zeta-agent/cordis");
    const gate = deferred();
    const system = new FiberSystem();
    const fiber = system.create({
      uid: "slow-fiber",
      inject: [],
      provide: [],
      apply: async () => {
        await gate.promise;
        return () => {};
      },
    });
    const loading = fiber.refresh();
    await until(() => fiber.state.kind === "LOADING");
    let error: unknown;
    try {
      await system.drain(5);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("FIBER_DRAIN_TIMEOUT");
    expect((error as Error).message).toContain("slow-fiber:LOADING");
    gate.resolve();
    await loading;
  });

  test("churn 后 system 无 fiber、binding 或 pending 残留", async () => {
    const { FiberSystem, key } = await import("@zeta-agent/cordis");
    const service = key<string>("churn");
    const system = new FiberSystem();
    for (let index = 0; index < 20; index += 1) {
      const provider = system.create({ uid: `p-${index}`, inject: [], provide: [service] });
      const consumer = system.create({ uid: `c-${index}`, inject: [service], provide: [] });
      await provider.refresh();
      await consumer.refresh();
      provider.remove();
      consumer.remove();
      await system.drain();
    }
    expect(system.fibers.size).toBe(0);
    expect(system.viewFor([service])).toBeNull();
  });
});

describe("T-05 context-scoped observer", () => {
  test("observer 按 context 隔离、生成 effect 树并隔离 handler 错误", async () => {
    const seenA: EffectMeta[] = [];
    const seenB: EffectMeta[] = [];
    const observerA: EffectObserver = {
      runId: "run-a",
      emit(meta) {
        seenA.push(meta);
        throw new Error("observer failed");
      },
    };
    const observerB: EffectObserver = { runId: "run-b", emit: (meta) => seenB.push(meta) };
    const a = createContext({ observer: observerA });
    const b = createContext({ observer: observerB });
    let disposed = 0;
    a.effect((fiber) => {
      fiber.effect(() => () => {
        disposed += 1;
      }, "child");
      return () => {};
    }, "parent");
    b.effect(() => () => {}, "b-only");
    await a.dispose();
    await b.dispose();
    expect(disposed).toBe(1);
    expect(seenA.map((meta) => meta.label)).toEqual(["parent"]);
    expect(seenA[0]?.fiberUid).toBe(a.uid);
    expect(seenA[0]?.children.map((meta) => meta.label)).toEqual(["child"]);
    expect(seenB.map((meta) => meta.label)).toEqual(["b-only"]);
  });
});
