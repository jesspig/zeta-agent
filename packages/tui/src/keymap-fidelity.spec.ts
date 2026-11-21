import { describe, expect, test } from "bun:test";
import { createKeymap, formatKeyCombo, resolveKittyCombo } from "./keymap";

describe("T-07 Kitty 修饰键解析与组合键", () => {
  test("resolveKittyCombo：Kitty 事件字段 → 规范 combo 字符串", () => {
    expect(resolveKittyCombo({ name: "t", ctrl: true })).toBe("ctrl+t");
    expect(resolveKittyCombo({ name: "up", meta: true, shift: true })).toBe("shift+meta+up");
    expect(resolveKittyCombo({ name: "return" })).toBe("return");
    expect(resolveKittyCombo({ name: "a", option: true })).toBe("option+a");
  });

  test("formatKeyCombo：按固定顺序拼接修饰键", () => {
    expect(formatKeyCombo({ name: "k", ctrl: true, meta: true })).toBe("ctrl+meta+k");
    expect(formatKeyCombo({ name: "o", ctrl: true, shift: true })).toBe("ctrl+shift+o");
  });

  test("三层注册表可按 Kitty combo 解析动作", () => {
    const keymap = createKeymap();
    keymap.register({ combo: "ctrl+shift+o", action: "expand", layer: "app" });
    expect(keymap.resolve(resolveKittyCombo({ name: "o", ctrl: true, shift: true }))?.action).toBe("expand");
  });
});
