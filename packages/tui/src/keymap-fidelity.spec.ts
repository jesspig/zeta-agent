import { describe, expect, test } from "bun:test";
import {
  createKeymap,
  createRuntimeKeymap,
  formatKeyCombo,
  normalizeKeyCombo,
  resolveKittyCombo,
} from "./keymap";

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

  test("Alt+Enter / Ctrl+Shift+C 的 combo 可解析并注册为 follow-up / copy-selection", () => {
    const keymap = createKeymap();
    keymap.register({ combo: "meta+return", action: "follow-up", layer: "tui" });
    keymap.register({ combo: "option+return", action: "follow-up", layer: "tui" });
    keymap.register({ combo: "ctrl+shift+c", action: "copy-selection", layer: "tui" });

    expect(resolveKittyCombo({ name: "return", meta: true })).toBe("meta+return");
    expect(resolveKittyCombo({ name: "return", option: true })).toBe("option+return");
    expect(resolveKittyCombo({ name: "c", ctrl: true, shift: true })).toBe("ctrl+shift+c");
    expect(keymap.resolve("meta+return")?.action).toBe("follow-up");
    expect(keymap.resolve("option+return")?.action).toBe("follow-up");
    expect(keymap.resolve("ctrl+shift+c")?.action).toBe("copy-selection");
  });

  test("修饰键规范化：别名、大小写、顺序归一到唯一 combo", () => {
    expect(normalizeKeyCombo("CTRL+Shift+a")).toBe("ctrl+shift+a");
    expect(normalizeKeyCombo({ name: "Enter", alt: true } as never)).toBe("meta+return");
    expect(normalizeKeyCombo("shift+ctrl+a")).toBe("ctrl+shift+a");
    expect(normalizeKeyCombo("cmd+k")).toBe("super+k");
    expect(normalizeKeyCombo("alt+esc")).toBe("meta+escape");
  });

  test("冲突检测在规范化之后生效，别名形式不能绕过同层唯一性", () => {
    const keymap = createKeymap();
    keymap.register({ combo: "ctrl+shift+a", action: "first", layer: "app" });
    expect(() => keymap.register({ combo: "SHIFT+CTRL+A", action: "second", layer: "app" })).toThrow(/KEYMAP_CONFLICT/);
    expect(keymap.resolve("alt+esc")?.action).toBeUndefined();
  });

  test("三层工厂：TUI/APP 默认键 + 用户层覆盖生效", () => {
    const keymap = createRuntimeKeymap({
      bindings: [{ combo: "ctrl+t", action: "user-toggle", layer: "user" }],
    });
    expect(keymap.resolve("ctrl+t")?.action).toBe("user-toggle");
    expect(keymap.resolve("ctrl+o")?.action).toBe("toggle-tools");
    expect(keymap.resolve("escape")?.action).toBe("abort");
    expect(() =>
      createRuntimeKeymap({
        bindings: [
          { combo: "ctrl+x", action: "one", layer: "user" },
          { combo: "CTRL+X", action: "two", layer: "user" },
        ],
      }),
    ).toThrow(/KEYMAP_CONFLICT/);
  });
});
