import { describe, expect, test } from "bun:test";
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
