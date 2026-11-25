import { describe, expect, test } from "bun:test";
import {
  createContext,
  createView,
  defineComponent,
  defineKey,
  notify,
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

describe("T-04 provider 与 committed view", () => {
  test("consumer 与 proxy 读取 provider 发布的同一对象", async () => {
    const service = defineKey<{ id: string }>("@zeta-agent/provider-test", "identity");
    const value = { id: "same-object" };
    const seen: unknown[] = [];
    const ctx = createContext();
    const provider = defineComponent({
      name: "identity-provider",
      provide: [service],
      apply: (fiber) => {
        fiber.provide(service, value);
        return () => {};
      },
    });
    const consumer = defineComponent({
      name: "identity-consumer",
      inject: [service],
      apply: (fiber) => {
        seen.push(fiber.get(service));
        return () => {};
      },
    });

    await ctx.use(provider).ready;
    await ctx.use(consumer).ready;
    expect(seen).toEqual([value]);
    expect(seen[0]).toBe(value);
    expect(ctx.get(service)).toBe(value);
    expect(createView<{ [key: symbol]: unknown }>(ctx)[service.symbol]).toBe(value);
    await ctx.dispose();
  });

  test("consumer 先加载时保持 PENDING，provider 可用后按依赖图激活", async () => {
    const service = defineKey<{ id: string }>("@zeta-agent/provider-test", "late-provider");
    const value = { id: "late" };
    const seen: unknown[] = [];
    const ctx = createContext();
    const consumer = ctx.use(
      defineComponent({
        name: "early-consumer",
        inject: [service],
        apply: (fiber) => {
          seen.push(fiber.get(service));
          return () => {};
        },
      })
    );
    await consumer.ready;
    expect(consumer.state.kind).toBe("PENDING");
    expect(seen).toEqual([]);

    const release = ctx.provide(service, value);
    await notify(ctx, [service]);
    expect(consumer.state.kind).toBe("ACTIVE");
    expect(seen[0]).toBe(value);
    release();
    await ctx.dispose();
  });

  test("reload 未完成时 consumer 仍读旧 committed 值，完成后切换新对象", async () => {
    const service = defineKey<{ id: string }>("@zeta-agent/provider-test", "reload-race");
    const first = { id: "v1" };
    const second = { id: "v2" };
    const gate = deferred();
    const seen: Array<{ phase: string; value: unknown }> = [];
    let current = first;
    let load = 0;
    const ctx = createContext();
    const provider = ctx.use(
      defineComponent({
        name: "reloading-provider",
        provide: [service],
        apply: (fiber) => {
          fiber.provide(service, current);
          return () => {};
        },
      })
    );
    const consumer = ctx.use(
      defineComponent({
        name: "reloading-consumer",
        inject: [service],
        apply: async (fiber) => {
          load += 1;
          seen.push({ phase: `apply-${load}`, value: fiber.get(service) });
          if (load === 2) {
            await gate.promise;
            seen.push({ phase: "apply-2-after-gate", value: fiber.get(service) });
          }
          return () => {};
        },
      })
    );
    await provider.ready;
    await consumer.ready;
    expect(seen).toEqual([{ phase: "apply-1", value: first }]);

    current = second;
    const providerReload = provider.update();
    await until(() => load === 2 && ctx.get(service) === second);
    expect(consumer.state.kind).toBe("LOADING");
    expect(seen[1]).toEqual({ phase: "apply-2", value: first });
    gate.resolve();
    await providerReload;
    await notify(ctx, [service]);
    expect(consumer.state.kind).toBe("ACTIVE");
    expect(seen[2]).toEqual({ phase: "apply-2-after-gate", value: first });
    expect(seen[3]).toBeUndefined();
    await ctx.dispose();
  });

  test("同一 key/realm 只允许一个 provider claim", async () => {
    const service = defineKey<string>("@zeta-agent/provider-test", "unique");
    const ctx = createContext();
    const release = ctx.provide(service, "first");
    expect(() => ctx.provide(service, "second")).toThrow("PROVIDER_DUPLICATE");
    expect(ctx.get(service)).toBe("first");
    release();
    const replacement = ctx.provide(service, "second");
    expect(ctx.get(service)).toBe("second");
    replacement();
    await ctx.dispose();
  });

  test("动态 check 失效后读取明确失败并触发 consumer 卸载", async () => {
    const service = defineKey<string>("@zeta-agent/provider-test", "dynamic-check");
    let valid = true;
    const ctx = createContext();
    const release = ctx.provide(service, "secret", { check: () => valid });
    const consumer = ctx.use(
      defineComponent({
        name: "checked-consumer",
        inject: [service],
        apply: () => () => {},
      })
    );
    await notify(ctx, [service]);
    expect(consumer.state.kind).toBe("ACTIVE");
    valid = false;
    expect(() => ctx.get(service)).toThrow("CAPABILITY_EXPIRED");
    await notify(ctx, [service]);
    expect(consumer.state.kind).toBe("PENDING");
    release();
    await ctx.dispose();
  });

  test("不同 realm 可同时提供同键服务且对象身份独立", async () => {
    const service = defineKey<{ realm: string }>("@zeta-agent/provider-test", "realm-provider");
    const aValue = { realm: "a" };
    const bValue = { realm: "b" };
    const root = createContext();
    const aRealm = Symbol("provider-a");
    const bRealm = Symbol("provider-b");
    const a = root.isolate(service, aRealm);
    const b = root.isolate(service, bRealm);
    const releaseA = a.provide(service, aValue);
    const releaseB = b.provide(service, bValue);
    await root.notify([service]);
    expect(a.get(service)).toBe(aValue);
    expect(b.get(service)).toBe(bValue);
    expect(() => root.get(service)).toThrow("UNDECLARED_ACCESS");
    releaseA();
    await root.notify([service]);
    expect(b.get(service)).toBe(bValue);
    releaseB();
    await root.dispose();
  });

  test("低层 target/committed Impl 保留 provider uid 与真实 value", async () => {
    const { FiberSystem, key } = await import("@zeta-agent/cordis");
    const service = key<{ id: string }>("impl-value");
    const value = { id: "low-level" };
    const system = new FiberSystem();
    const provider = system.create({
      uid: "impl-provider",
      inject: [],
      provide: [service],
      values: new Map([[service.symbol, value]]),
    });
    const consumer = system.create({ uid: "impl-consumer", inject: [service], provide: [] });
    await provider.refresh();
    await consumer.refresh();
    const impl = consumer.state.kind === "ACTIVE" ? consumer.state.committed.get(service) : undefined;
    expect(impl?.uid).toBe(provider.uid);
    expect(impl?.value).toBe(value);
    expect(() =>
      system.create({ uid: "duplicate", inject: [], provide: [service] })
    ).toThrow("PROVIDER_DUPLICATE");
  });

  test("同值重新 provide 触发 consumer reload，Impl generation/revision 递增", async () => {
    const service = defineKey<string>("@zeta-agent/provider-test", "same-value-generation");
    const seen: string[] = [];
    const ctx = createContext();
    const release = ctx.provide(service, "same");
    const consumer = ctx.use(
      defineComponent({
        name: "same-value-consumer",
        inject: [service],
        apply: (fiber) => {
          seen.push(fiber.get(service));
          return () => {};
        },
      })
    );
    await ctx.notify([service]);
    expect(seen).toEqual(["same"]);
    const before = consumer.state.kind === "ACTIVE" ? consumer.state.committed.get(service)?.generation : undefined;
    expect(typeof before).toBe("number");

    release();
    ctx.provide(service, "same");
    await ctx.notify([service]);
    const after = consumer.state.kind === "ACTIVE" ? consumer.state.committed.get(service)?.generation : undefined;
    expect(seen).toEqual(["same", "same"]);
    expect(typeof after).toBe("number");
    expect(after!).toBeGreaterThan(before!);
    await ctx.dispose();
  });

  test("FiberSystem.revisionOf 暴露按 realm/键的绑定序号", async () => {
    const { FiberSystem, key } = await import("@zeta-agent/cordis");
    const service = key<string>("revision-observed");
    const system = new FiberSystem();
    const provider = system.create({
      uid: "revision-provider",
      inject: [],
      provide: [service],
      values: new Map([[service.symbol, "v"]]),
    });
    await provider.refresh();
    const first = system.revisionOf(service, provider.realm);
    const release = provider.provide(service, "v");
    const second = system.revisionOf(service, provider.realm);
    expect(second).toBe(first + 1);
    release();
    await provider.remove();
  });
});
