import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "./types";
import {
  contribute,
  createContext,
  defineComponent,
  defineKey,
  defineRegistry,
  notify,
  resolveRegistry,
  use,
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
});
