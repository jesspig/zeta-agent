import { expect, test } from "bun:test";
import type { ControlFrame, RuntimeProtocol } from "@zeta-agent/agent";
import {
  createBackendKeyEvent,
  type BackendEvent,
  type BackendKeyEvent,
  type BackendMountOptions,
  type BackendSize,
  type Frame,
  type RendererBackend,
  type TestHandle,
} from "./backend";
import type { FrameState } from "./frame-state";
import { renderTui } from "./runtime";

class RecordingBackend implements RendererBackend {
  readonly mounts: BackendMountOptions[] = [];
  readonly frames: FrameState[] = [];
  readonly events: BackendEvent[] = [];
  readonly clipboardTexts: string[] = [];
  readonly listeners = new Set<(event: BackendEvent) => void>();
  destroyed = false;

  private assertAlive(): void {
    if (this.destroyed) throw new Error("RecordingBackend: already destroyed");
  }

  render(frame: FrameState): Frame {
    this.assertAlive();
    this.frames.push(frame);
    return { snapshot: frame.lines.join("\n") };
  }
  mount(options: BackendMountOptions): void {
    this.assertAlive();
    this.mounts.push(options);
  }
  input(key: BackendKeyEvent): boolean {
    this.assertAlive();
    if (key.eventType === "release" || key.defaultPrevented) return false;
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
  readonly clipboard = {
    copy: (text: string): void => {
      this.assertAlive();
      this.clipboardTexts.push(text);
    },
  };
  async testRender(): Promise<TestHandle> {
    return {
      async renderOnce() {},
      captureCharFrame: () => "recording",
      destroy() {},
    };
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
  }

  emitKey(input: Parameters<typeof createBackendKeyEvent>[0]): void {
    this.input(createBackendKeyEvent(input));
  }
}

function fakeProtocol(frames: ControlFrame[]): RuntimeProtocol {
  const dispatch = async (frame: ControlFrame) => {
    frames.push(frame);
    return { type: "control.result" as const, ok: true, action: frame.action };
  };
  return {
    session: { id: "s", messages: () => [], reset: () => {} },
    control: { dispatch },
    event: { subscribe: () => () => {} },
    dispatch,
  };
}

test("renderTui({backend}) 真实接管：mount/render/key/resize/clipboard/destroy", async () => {
  const backend = new RecordingBackend();
  const frames: ControlFrame[] = [];
  let exited = false;
  const handle = await renderTui({
    backend,
    protocol: fakeProtocol(frames),
    messages: [{ role: "assistant", content: "hello-from-backend" }],
    onExit: () => { exited = true; },
    keyBindings: [
      { combo: "ctrl+q", action: "exit", layer: "user" },
      { combo: "ctrl+y", action: "copy-selection", layer: "user" },
    ],
  });

  try {
    expect(backend.mounts).toHaveLength(1);
    expect(backend.mounts[0]?.width).toBeGreaterThan(0);
    expect(backend.frames.length).toBeGreaterThan(0);
    expect(backend.frames[0]?.lines.join(" ")).toContain("hello-from-backend");

    backend.emitKey({ name: "q", ctrl: true });
    expect(exited).toBe(true);

    backend.emitKey({ name: "y", ctrl: true });
    expect(backend.clipboardTexts).toHaveLength(1);

    backend.resize({ width: 42, height: 11 });
    expect(backend.frames.at(-1)?.width).toBe(42);

    backend.emitKey({ name: "escape" });
    expect(frames.map((frame) => frame.action)).toContain("abort");
  } finally {
    await handle.destroy();
  }
  expect(backend.destroyed).toBe(true);
});

test("renderTui 可输出含 event-loop/cpu/rss/p99 的 Debug HUD", async () => {
  const backend = new RecordingBackend();
  const handle = await renderTui({
    backend,
    messages: Array.from({ length: 5 }, (_, index) => ({ role: "assistant", content: `m${index}` })),
    debugHud: { contextLimit: 100 },
  });
  try {
    const hud = backend.frames.at(-1)?.hud;
    expect(hud).toBeDefined();
    expect(hud).toContain("EVENT p99=");
    expect(hud).toContain("FRAME p99=");
    expect(hud).toContain("CPU");
    expect(hud).toContain("RSS");
    expect(hud).toContain("N=");
  } finally {
    await handle.destroy();
  }
});

test("renderTui 自定义后端：release/已阻止默认行为的按键不触发动作", async () => {
  const backend = new RecordingBackend();
  let exited = false;
  const handle = await renderTui({
    backend,
    messages: [],
    onExit: () => { exited = true; },
    keyBindings: [{ combo: "ctrl+q", action: "exit", layer: "user" }],
  });
  try {
    backend.emitKey({ name: "q", ctrl: true, eventType: "release" });
    const alreadyPrevented = createBackendKeyEvent({ name: "q", ctrl: true });
    alreadyPrevented.preventDefault();
    backend.input(alreadyPrevented);
    expect(exited).toBe(false);
  } finally {
    await handle.destroy();
  }
});
