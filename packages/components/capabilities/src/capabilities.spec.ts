import { describe, expect, test } from "bun:test";
import {
  claim,
  compose,
  contribute,
  createSeam,
  defineRegistry,
  HealthBoard,
  provide,
  seamCatalog,
  release,
  scoped,
  resolve,
} from "./index";

describe("scope/seam/registry/health", () => {
  test("重复 provide 同一 seam 抛错", () => {
    const seam = createSeam<string>("log", "sink");
    const dispose = provide(seam, "a");
    expect(() => provide(seam, "b")).toThrow("SEAM_DUPLICATE");
    dispose();
    expect(() => provide(seam, "b")).not.toThrow();
  });

  test("resolve 返回已提供实现", () => {
    const seam = createSeam<number>("cfg", "limit");
    provide(seam, 42);
    expect(resolve(seam)).toBe(42);
  });

  test("HealthBoard 重复 claim 抛错，release 后可再 claim", () => {
    const board = new HealthBoard();
    const first = claim(board, "writer");
    expect(() => claim(board, "writer")).toThrow("HEALTH_DUPLICATE");
    release(first);
    expect(claim(board, "writer")).toBeDefined();
  });

  test("contribution compose 有回退值", () => {
    const registry = defineRegistry<number, number>("sum", { compose: (items) => items.reduce((a, b) => a + b, 0) });
    contribute(registry, 1);
    contribute(registry, 2);
    expect(resolve(registry)).toBe(3);
    const empty = defineRegistry<number, number>("empty", { compose: (items) => items.reduce((a, b) => a + b, 0) });
    expect(resolve(empty)).toBe(0);
  });

  test("Scoped<T> 事件只触达同 key listener", () => {
    const bus = scoped<{ kind: string }>("s1");
    const order: string[] = [];
    bus.on((e) => order.push(`a:${e.kind}`), "s1");
    bus.on((e) => order.push(`b:${e.kind}`), "s2");
    bus.emit({ kind: "x" }, "s1");
    expect(order).toEqual(["a:x"]);
  });

  test("compose 纯同步且保持输入不变", () => {
    const input = [1, 2, 3];
    expect(compose(input, (items) => items.length)).toBe(3);
    expect(input).toEqual([1, 2, 3]);
  });

  test("seam catalog 生成式登记 role", () => {
    const seam = createSeam<string>("cat", "item", "storage");
    const entry = seamCatalog().find((item) => item.role === "storage");
    expect(entry).toBeDefined();
    expect(seam.ns).toBe("cat");
  });
});
