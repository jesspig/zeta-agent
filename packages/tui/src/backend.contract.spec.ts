import { expect, test } from "bun:test";
import { testRender as renderFrame, type FrameState } from "./frame";
import type { Frame, RendererBackend, TestHandle, TestRenderOptions } from "./backend";

class FakeBackend implements RendererBackend {
  render(frame: FrameState): Frame {
    return { snapshot: renderFrame(frame) };
  }
  async testRender(app: () => FrameState, opts: TestRenderOptions): Promise<TestHandle> {
    let current = renderFrame(app());
    let destroyed = false;
    return {
      async renderOnce() {
        if (destroyed) throw new Error("destroyed");
        current = renderFrame(app());
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
