import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTui, type RendererBackend, type TuiHandle } from "./index";
import { createSlotRegistry } from "./slots";

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
  const files = ["slots.ts", "signal.ts", "virtual.ts", "hud.ts", "frame-state.ts", "backend.ts"];
  for (const file of files) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text).not.toContain("@opentui");
  }
});

const SEAM_ALLOWLIST = ["runtime-plugin-loader.tsx", "slots-native.tsx"];

test("守护白名单：仅 2 个 seam 文件允许直接 import OpenTUI", () => {
  const guardSource = readFileSync(
    fileURLToPath(new URL("../../../scripts/guard-architecture.mjs", import.meta.url)),
    "utf8",
  );
  for (const file of SEAM_ALLOWLIST) {
    expect(guardSource).toContain(file);
  }
  for (const file of [
    "slots.ts", "signal.ts", "virtual.ts", "hud.ts", "frame-state.ts", "backend.ts",
  ]) {
    expect(SEAM_ALLOWLIST).not.toContain(file);
  }
});

test("IF-05 facade string 槽位契约保持：createSlotRegistry 注册/渲染/释放字符串", () => {
  const registry = createSlotRegistry();
  const handle = registry.register("footer", "hello");
  expect(registry.render("footer")).toBe("hello");
  expect(registry.slots()).toContain("footer");
  handle.dispose();
  expect(registry.render("footer")).toBe("");
  expect(() => registry.register("not-a-slot" as never, "x")).toThrow();
});
