import { describe, expect, test } from "bun:test";
import { createPluginRegistry, REQUIRED_ROOTS } from "./registry";

describe("T-16 插件注册入口：order / realm / replaceable / required root", () => {
  test("order 决定快照顺序，同 order 按注册序", () => {
    const registry = createPluginRegistry<string>();
    registry.register({ name: "b", value: "B", order: 20 });
    registry.register({ name: "a", value: "A", order: 10 });
    registry.register({ name: "c", value: "C", order: 20 });
    expect(registry.snapshot().map((slot) => slot.name)).toEqual(["a", "b", "c"]);
  });

  test("realm 隔离：不同 realm 的同名条目互不覆盖", () => {
    const realmA = Symbol("a");
    const realmB = Symbol("b");
    const registry = createPluginRegistry<string>();
    registry.register({ name: "tool", value: "A", realm: realmA });
    registry.register({ name: "tool", value: "B", realm: realmB });
    expect(registry.resolve("tool", realmA)).toBe("A");
    expect(registry.resolve("tool", realmB)).toBe("B");
    expect(registry.snapshot()).toHaveLength(2);
  });

  test("replaceable 同名替换：旧 disposer 不删新条目", () => {
    const registry = createPluginRegistry<string>();
    const stopOld = registry.register({ name: "tool", value: "old", replaceable: true });
    registry.register({ name: "tool", value: "new", replaceable: true });
    stopOld();
    stopOld();
    expect(registry.resolve("tool")).toBe("new");
  });

  test("不可替换条目拒绝同名覆盖", () => {
    const registry = createPluginRegistry<string>();
    registry.register({ name: "tool", value: "root", replaceable: false });
    expect(() => registry.register({ name: "tool", value: "override" })).toThrow("REPLACE_REJECTED");
    expect(registry.resolve("tool")).toBe("root");
  });

  test("required root 不可替换", () => {
    const root = REQUIRED_ROOTS[0]!;
    const registry = createPluginRegistry<string>();
    registry.register({ name: root, value: "core", source: "builtin", required: true });
    expect(() => registry.register({ name: root, value: "hijack" })).toThrow("REQUIRED_ROOT_REPLACED");
    expect(registry.resolve(root)).toBe("core");
  });
});
