import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTui, type RendererBackend, type TuiHandle } from "./index";

class UserBackend implements RendererBackend {
  render(frame: { width: number; height: number; lines: readonly string[] }): { snapshot: string } {
    return { snapshot: frame.lines.join("\n") };
  }
  async testRender() {
    return {
      async renderOnce() {},
      captureCharFrame: () => "user-backend",
      destroy() {},
    };
  }
  destroy() {}
}

test("createTui 可注入用户自带后端（非仓库发布实现）", () => {
  const user = new UserBackend();
  const tui: TuiHandle = createTui({ backend: user });
  expect(tui.backend).toBe(user);
  expect(tui.render({ width: 4, height: 2, lines: ["a", "b"] }).snapshot).toBe("a\nb");
  tui.destroy();
});

test("业务组件零直接 import OpenTUI（守护测试）", () => {
  const files = ["slots.ts", "signal.ts", "virtual.ts", "hud.ts", "frame.ts", "backend.ts"];
  for (const file of files) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text).not.toContain("@opentui");
  }
});
