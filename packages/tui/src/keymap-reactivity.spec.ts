import { describe, expect, test } from "bun:test";
import {
  createReactiveKeymap,
  KeymapConflictError,
  type KeyBinding,
} from "./keymap";

describe("T-23 keymap 响应式热更新", () => {
  test("默认三层键位可用，setBindings 后立即按新表解析", () => {
    const keymap = createReactiveKeymap();
    expect(keymap.resolve("ctrl+d")?.action).toBe("exit");
    keymap.setBindings([{ combo: "ctrl+d", action: "custom-exit", layer: "user" }]);
    expect(keymap.resolve("ctrl+d")?.action).toBe("custom-exit");
    expect(keymap.list().some((binding) => binding.action === "custom-exit")).toBe(true);
  });

  test("热更新冲突显式抛出，不静默覆盖", () => {
    const keymap = createReactiveKeymap();
    const bindings: readonly KeyBinding[] = [
      { combo: "ctrl+g", action: "a", layer: "user" },
      { combo: "ctrl+g", action: "b", layer: "user" },
    ];
    expect(() => keymap.setBindings(bindings)).toThrow(KeymapConflictError);
    // 失败后保留上一次生效的键位表。
    expect(keymap.resolve("ctrl+d")?.action).toBe("exit");
  });
});
