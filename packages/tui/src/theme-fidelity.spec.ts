import { describe, expect, test } from "bun:test";
import {
  buildSystemPalette,
  createDebouncedThemeReloader,
  generateOklchPalette,
  lightnessOf,
  SEMANTIC_TOKENS,
} from "./theme-generator";
import { createThemeRegistry, type ColorToken } from "./theme";

describe("T-05 主题增强", () => {
  test("语义 token 扩展到 ~60 个，保留原有 8 个基础 token", () => {
    expect(SEMANTIC_TOKENS.length).toBeGreaterThanOrEqual(50);
    expect(SEMANTIC_TOKENS.length).toBeLessThanOrEqual(100);
    for (const base of ["accent", "text", "border", "muted", "error", "info", "warning", "thinking"] as ColorToken[]) {
      expect(SEMANTIC_TOKENS).toContain(base);
    }
    const registry = createThemeRegistry();
    expect(registry.tokens().length).toBeGreaterThanOrEqual(50);
  });

  test("fallback 链：自定义主题缺失 token 时逐级回退（自定义 > 基础 > dark）", () => {
    const registry = createThemeRegistry();
    const darkAccent = registry.theme("dark").color("accent");
    registry.define("custom", { colors: { accent: "#123456" } });
    expect(registry.theme("custom").color("accent")).toBe("#123456");
    // 未定义的 token 回退 dark 基础色，而不是 undefined。
    expect(registry.theme("custom").color("info")).toBe(registry.theme("dark").color("info"));
    expect(darkAccent).not.toBe("#123456");
  });

  test("OKHSL 从终端调色板派生 system 主题（纯函数，输出 #RRGGBB）", () => {
    const palette = generateOklchPalette({
      foreground: "#c9d1d9",
      background: "#0d1117",
      ansi: ["#000000", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#aaaaaa"],
    });
    expect(palette.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(palette.text).toBe("#c9d1d9");
    expect(palette.background).toBe("#0d1117");
    expect(lightnessOf(palette.text)).toBeGreaterThan(lightnessOf(palette.background));

    const light = generateOklchPalette({
      foreground: "#1f2328",
      background: "#ffffff",
      ansi: ["#000000", "#cf222e", "#1a7f37", "#9a6700", "#0969da", "#8250df", "#1a7f8f", "#656d76"],
    });
    expect(lightnessOf(light.background)).toBeGreaterThan(lightnessOf(light.text));
  });

  test("明暗自动检测：背景亮度低于阈值判 dark，高于判 light", () => {
    const dark = buildSystemPalette({ foreground: "#c9d1d9", background: "#0d1117", ansi: [] });
    expect(dark.mode).toBe("dark");
    const light = buildSystemPalette({ foreground: "#1f2328", background: "#ffffff", ansi: [] });
    expect(light.mode).toBe("light");
  });

  test("主题文件 100ms 防抖热重载：默认 100ms，合并连续通知后单次触发", async () => {
    let triggers = 0;
    // 显式传入 20ms 仅用于加速测试；生产默认值为 100ms。
    const reloader = createDebouncedThemeReloader(() => { triggers += 1; }, 20);
    reloader.notify();
    reloader.notify();
    reloader.notify();
    expect(triggers).toBe(0);
    await Bun.sleep(50);
    expect(triggers).toBe(1);
    reloader.dispose();

    const withDefault = createDebouncedThemeReloader(() => {});
    expect(withDefault.delayMs).toBe(100);
    withDefault.dispose();
  });
});
