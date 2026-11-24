import { expect, test } from "bun:test";
import type { FrameState } from "./frame-state";
import {
  createBackendKeyEvent,
  type BackendEvent,
  type Frame,
  type RendererBackend,
  type TestHandle,
  type TestRenderOptions,
} from "./backend";

function contentFrame(frame: FrameState): string {
  const body = [...frame.lines];
  if (frame.hud !== undefined) body.push(frame.hud);
  const rows: string[] = [];
  for (let i = 0; i < frame.height; i += 1) {
    const raw = body[i] ?? "";
    rows.push(raw.length > frame.width ? raw.slice(0, frame.width) : raw.padEnd(frame.width, " "));
  }
  return rows.join("\n");
}

class FakeBackend implements RendererBackend {
  private destroyed = false;
  private mounted = false;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private lastClipboard = "";
  readonly clipboard = {
    copy: (text: string) => {
      this.assertAlive();
      this.lastClipboard = text;
    },
  };

  private assertAlive(): void {
    if (this.destroyed) throw new Error("FakeBackend: already destroyed");
  }

  render(frame: FrameState): Frame {
    this.assertAlive();
    return { snapshot: contentFrame(frame) };
  }
  mount(): void {
    this.assertAlive();
    if (this.mounted) throw new Error("FakeBackend: already mounted");
    this.mounted = true;
  }
  input(key: ReturnType<typeof createBackendKeyEvent>): boolean {
    this.assertAlive();
    if (!this.mounted) throw new Error("FakeBackend: not mounted");
    if (key.defaultPrevented) return false;
    for (const listener of [...this.listeners]) listener({ type: "key", key });
    return this.listeners.size > 0;
  }
  event(listener: (event: BackendEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  resize(size: { width: number; height: number }): void {
    this.assertAlive();
    for (const listener of [...this.listeners]) listener({ type: "resize", size });
  }
  clipboardText(): string {
    return this.lastClipboard;
  }
  async testRender(app: () => FrameState, opts: TestRenderOptions): Promise<TestHandle> {
    let current = contentFrame(app());
    let destroyed = false;
    return {
      async renderOnce() {
        if (destroyed) throw new Error("destroyed");
        current = contentFrame(app());
      },
      captureCharFrame() {
        if (destroyed) throw new Error("destroyed");
        return current;
      },
      destroy() {
        destroyed = true;
      },
    };
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
  }
}

export function backendContractTests(name: string, factory: () => RendererBackend): void {
  const app = (): FrameState => ({
    width: 20,
    height: 6,
    lines: ["hello", "world"],
    hud: "CTX 1/2 50%",
  });

  test(`${name}: render 返回定宽定高快照`, () => {
    const backend = factory();
    const frame = backend.render(app());
    const lines = frame.snapshot.split("\n");
    expect(lines.length).toBe(6);
    for (const line of lines) expect(line.length).toBe(20);
  });

  test(`${name}: testRender 帧快照稳定`, async () => {
    const backend = factory();
    const handle = await backend.testRender(app, { width: 20, height: 6 });
    try {
      await handle.renderOnce();
      const first = handle.captureCharFrame();
      await handle.renderOnce();
      expect(handle.captureCharFrame()).toBe(first);
    } finally {
      handle.destroy();
    }
  });

  test(`${name}: destroy 幂等`, async () => {
    const backend = factory();
    const handle = await backend.testRender(app, { width: 20, height: 6 });
    expect(() => {
      handle.destroy();
      handle.destroy();
    }).not.toThrow();
    expect(() => {
      backend.destroy();
      backend.destroy();
    }).not.toThrow();
  });

  test(`${name}: mount/input/event/resize/clipboard/destroy 完整生命周期`, async () => {
    const backend = factory();
    const seen: BackendEvent[] = [];
    const off = backend.event((event) => seen.push(event));
    await backend.mount({ width: 20, height: 6, screenMode: "alternate-screen", useKittyKeyboard: true });
    const consumed = backend.input(createBackendKeyEvent({ name: "c", ctrl: true }));
    expect(consumed).toBe(true);
    backend.resize({ width: 30, height: 9 });
    backend.clipboard.copy("clip");
    expect(seen.map((event) => event.type)).toEqual(["key", "resize"]);
    off();
    backend.destroy();
  });

  test(`${name}: destroy 后 mount/input/resize 拒绝继续接管`, async () => {
    const backend = factory();
    backend.destroy();
    expect(() => backend.mount({ width: 10, height: 2 })).toThrow(/destroy/i);
    expect(() => backend.input(createBackendKeyEvent({ name: "a" }))).toThrow(/destroy/i);
    expect(() => backend.resize({ width: 10, height: 2 })).toThrow(/destroy/i);
  });
}

backendContractTests("测试内 fake 后端（非发布实现）", () => new FakeBackend());
