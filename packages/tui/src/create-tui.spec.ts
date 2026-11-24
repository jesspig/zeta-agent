import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createBackendKeyEvent,
  createTui,
  type BackendClipboard,
  type BackendEvent,
  type BackendKeyEvent,
  type BackendMountOptions,
  type BackendSize,
  type Frame,
  type RendererBackend,
  type TuiHandle,
} from "./index";
import type { FrameState } from "./frame-state";
import { createSlotRegistry } from "./slots";

class UserBackend implements RendererBackend {
  private destroyed = false;
  private mounted = false;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  readonly clipboard: BackendClipboard = {
    copy: () => {},
  };

  private assertAlive(): void {
    if (this.destroyed) throw new Error("UserBackend: already destroyed");
  }

  render(frame: FrameState): Frame {
    this.assertAlive();
    return { snapshot: frame.lines.join("\n") };
  }
  mount(_options: BackendMountOptions): void {
    this.assertAlive();
    this.mounted = true;
  }
  input(key: BackendKeyEvent): boolean {
    this.assertAlive();
    if (!this.mounted) throw new Error("UserBackend: not mounted");
    for (const listener of [...this.listeners]) listener({ type: "key", key });
    return this.listeners.size > 0;
  }
  event(listener: (event: BackendEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  resize(size: BackendSize): void {
    this.assertAlive();
    for (const listener of [...this.listeners]) listener({ type: "resize", size });
  }
  async testRender(): ReturnType<RendererBackend["testRender"]> {
    return {
      async renderOnce() {},
      captureCharFrame: () => "user-backend",
      destroy() {},
    };
  }
  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
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
