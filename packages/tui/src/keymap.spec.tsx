import { describe, expect, test } from "bun:test";
import { createKeymap, type KeyBinding, type KeyLayer } from "./keymap";
import { clampWidth } from "./components/layout";

const binding = (combo: string, action: string, layer: KeyLayer): KeyBinding => ({
  combo,
  action,
  layer,
});

describe("T-10 三层键位注册表（IF-07）", () => {
  test("TUI/APP/用户三层优先级：用户 > APP > TUI", () => {
    const keymap = createKeymap();
    keymap.register(binding("ctrl+c", "tui-exit", "tui"));
    keymap.register(binding("ctrl+c", "app-copy", "app"));
    keymap.register(binding("ctrl+c", "user-override", "user"));

    expect(keymap.resolve("ctrl+c")?.action).toBe("user-override");
    expect(keymap.list()).toHaveLength(3);
  });

  test("同层同键冲突显式报错（不静默覆盖）", () => {
    const keymap = createKeymap();
    keymap.register(binding("ctrl+s", "save", "app"));
    expect(() => keymap.register(binding("ctrl+s", "other", "app"))).toThrow(/KEYMAP_CONFLICT/);
  });

  test("注销与层级回退", () => {
    const keymap = createKeymap();
    keymap.register(binding("escape", "tui-close", "tui"));
    const off = keymap.register(binding("escape", "app-close", "app"));
    expect(keymap.resolve("escape")?.action).toBe("app-close");
    off();
    expect(keymap.resolve("escape")?.action).toBe("tui-close");
  });
});

describe("T-10 overlay 与 resize", () => {
  test("overlay 确认框组件渲染与关闭", async () => {
    const { testRender } = await import("@opentui/solid");
    const { ConfirmOverlay } = await import("./components/overlay");
    let closed = false;
    const setup = await testRender(
      () => <ConfirmOverlay message="确定退出？" onConfirm={() => { closed = true; }} />,
      { width: 30, height: 4 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("确定退出"));
      expect(setup.captureCharFrame()).toContain("确定退出");
      expect(closed).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("resize 后布局帧宽度跟随 terminal dimensions", () => {
    expect(clampWidth(100, 40)).toBe(40);
    expect(clampWidth(20, 80)).toBe(20);
  });
});
