import { expect, test } from "bun:test";
import type { FrameState } from "./frame-state";
import type { Frame, RendererBackend, TestHandle, TestRenderOptions } from "./backend";

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
  render(frame: FrameState): Frame {
    return { snapshot: contentFrame(frame) };
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
  destroy(): void {}
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
}

backendContractTests("测试内 fake 后端（非发布实现）", () => new FakeBackend());
