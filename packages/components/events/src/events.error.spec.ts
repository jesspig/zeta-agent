import { describe, expect, test } from "bun:test";
import { createEventBus } from "./events";

declare module "./types" {
  interface Events {
    "err:test": string;
  }
}

/** 补审 CR-S02：emit 的异步监听器拒绝必须有明确错误出口，不产生未处理拒绝。 */
describe("T-43 事件异步拒绝出口", () => {
  test("emit 捕获同步抛错并交给 onError", () => {
    const errors: unknown[] = [];
    const bus = createEventBus({ onError: (e) => errors.push(e) });
    bus.on("err:test", () => { throw new Error("boom-sync"); });
    bus.emit("err:test", "x");
    expect(errors).toHaveLength(1);
  });

  test("emit 捕获异步拒绝并交给 onError", async () => {
    const errors: unknown[] = [];
    const bus = createEventBus({ onError: (e) => errors.push(e) });
    bus.on("err:test", async () => { throw new Error("boom-async"); });
    bus.emit("err:test", "x");
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
  });
});
