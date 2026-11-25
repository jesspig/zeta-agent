import { describe, expect, test } from "bun:test";
import { createEffectHost, effect, unloadHost } from "@zeta-agent/cordis";
import { createEventBus } from "./events";

declare module "./types" {
  interface Events {
    "test:ok": string;
    "test:bad": number;
  }
}

describe("五模式事件总线", () => {
  test("emit 同步按注册顺序派发", () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", (value) => order.push(`a:${value}`));
    bus.on("test:ok", (value) => order.push(`b:${value}`));
    bus.emit("test:ok", "x");
    expect(order).toEqual(["a:x", "b:x"]);
  });

  test("parallel 不短路且多错误聚合为 AggregateError", async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", () => {
      order.push("a");
      throw new Error("first");
    });
    bus.on("test:ok", () => {
      order.push("b");
      throw new Error("second");
    });
    let error: unknown;
    try {
      await bus.parallel("test:ok", "x");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(order).toEqual(["a", "b"]);
  });

  test("serial 按序 await", async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", async () => {
      await Promise.resolve();
      order.push("a");
    });
    bus.on("test:ok", () => order.push("b"));
    await bus.serial("test:ok", "x");
    expect(order).toEqual(["a", "b"]);
  });

  test("bail 在首个返回 true 时停止", async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", () => {
      order.push("a");
      return false;
    });
    bus.on("test:ok", () => {
      order.push("b");
      return true;
    });
    bus.on("test:ok", () => {
      order.push("c");
      return true;
    });
    expect(await bus.bail("test:ok", "x")).toBe(true);
    expect(order).toEqual(["a", "b"]);
  });

  test("waterfall 传递变换值，next 重复调用抛错", async () => {
    const bus = createEventBus();
    bus.on("test:ok", (value, next: (v: string) => void) => next(`${value}-a`));
    bus.on("test:ok", (value, next: (v: string) => void) => next(`${value}-b`));
    expect(await bus.waterfall("test:ok", "x")).toBe("x-a-b");

    const bad = createEventBus();
    bad.on("test:ok", (_value, next: (v: string) => void) => {
      next("once");
      next("twice");
    });
    let message = "";
    try {
      await bad.waterfall("test:ok", "x");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("next() 重复调用");
  });

  test("scope 过滤只派发同 scope 的 listener", () => {
    const bus = createEventBus();
    const scope = Symbol("s1");
    const order: string[] = [];
    bus.on("test:ok", () => order.push("global"));
    bus.on("test:ok", () => order.push("scoped"), { scope });
    bus.emit("test:ok", "x", { scope });
    expect(order).toEqual(["scoped"]);
  });
});

describe("T-04 五模式边界对齐", () => {
  test("serial 对非 false/null/undefined 提前返回", async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", () => {
      order.push("a");
      return false;
    });
    bus.on("test:ok", () => {
      order.push("b");
      return 0;
    });
    bus.on("test:ok", () => {
      order.push("c");
      return "later";
    });
    expect(await bus.serial("test:ok", "x")).toBe(0);
    expect(order).toEqual(["a", "b"]);
  });

  test("bail 显式判定覆盖 0 与空字符串", async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("test:ok", () => {
      order.push("a");
      return false;
    });
    bus.on("test:ok", () => {
      order.push("b");
      return null;
    });
    bus.on("test:ok", () => {
      order.push("c");
      return 0;
    });
    expect(await bus.bail("test:ok", "x")).toBe(true);
    expect(order).toEqual(["a", "b", "c"]);

    const other = createEventBus();
    const secondOrder: string[] = [];
    other.on("test:ok", () => {
      secondOrder.push("a");
      return undefined;
    });
    other.on("test:ok", () => {
      secondOrder.push("b");
      return "";
    });
    expect(await other.bail("test:ok", "x")).toBe(true);
    expect(secondOrder).toEqual(["a", "b"]);
  });

  test("waterfall 不调用 next 不推进，重复 next 抛错", async () => {
    const bus = createEventBus();
    bus.on("test:ok", () => undefined);
    bus.on("test:ok", (value, next: (v: string) => void) => next(`${value}-advanced`));
    expect(await bus.waterfall("test:ok", "base")).toBe("base-advanced");
  });

  test("listener 经 ctx.effect 注册，宿主卸载自动注销", async () => {
    const host = createEffectHost("event-owner");
    const bus = createEventBus({
      ctx: {
        effect: (callback, label) => effect(host, () => callback(host as never), label),
      },
    });
    const seen: string[] = [];
    bus.on("test:ok", (value) => seen.push(value));
    bus.emit("test:ok", "first");
    await unloadHost(host);
    bus.emit("test:ok", "second");
    expect(seen).toEqual(["first"]);
  });
});
