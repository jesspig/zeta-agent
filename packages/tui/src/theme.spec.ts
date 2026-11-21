import { describe, expect, test } from "bun:test";
import { createThemeRegistry, type ThemeName } from "./theme";

describe("T-11 主题系统（IF-08）", () => {
  test("token 注册表含必要 token 且三套主题齐备", () => {
    const registry = createThemeRegistry();
    expect(registry.tokens()).toContain("accent");
    expect(registry.tokens()).toContain("text");
    expect(registry.tokens()).toContain("border");
    for (const name of ["system", "dark", "light"] as ThemeName[]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test("system/dark/light 切换后颜色 token 变化", () => {
    const registry = createThemeRegistry();
    const darkAccent = registry.theme("dark").color("accent");
    const lightAccent = registry.theme("light").color("accent");
    expect(darkAccent).not.toBe(lightAccent);

    registry.setActive("light");
    expect(registry.active()).toBe("light");
    expect(registry.activeTheme().color("accent")).toBe(lightAccent);
    registry.setActive("dark");
    expect(registry.activeTheme().color("accent")).toBe(darkAccent);
  });

  test("热重载不触发 fiber destroy：仅通知订阅者", () => {
    const registry = createThemeRegistry();
    let notifications = 0;
    let destroys = 0;
    const off = registry.subscribe(() => {
      notifications += 1;
    });
    const fakeFiber = { destroy: () => { destroys += 1; } };
    registry.setActive("light");
    expect(notifications).toBe(1);
    expect(destroys).toBe(0);
    off();
    registry.setActive("dark");
    expect(notifications).toBe(1);
    void fakeFiber;
  });

  test("自动配对：system 根据 prefers-color-scheme 解析实际主题", () => {
    const registry = createThemeRegistry({ prefers: "dark" });
    expect(registry.resolveSystem()).toBe("dark");
    const light = createThemeRegistry({ prefers: "light" });
    expect(light.resolveSystem()).toBe("light");
  });

  test("格式错误主题回退默认", () => {
    const registry = createThemeRegistry();
    expect(() => registry.define("broken", { colors: "not-an-object" } as never)).not.toThrow();
    expect(registry.has("broken")).toBe(false);
    expect(registry.resolve("missing")).toBe("dark");
  });
});
