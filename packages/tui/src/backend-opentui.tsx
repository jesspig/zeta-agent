import { testRender as openTuiTestRender } from "@opentui/solid";
import { For } from "solid-js";
import type { FrameState } from "./frame-state";
import {
  type BackendEvent,
  type BackendKeyEvent,
  type BackendMountOptions,
  type BackendSize,
  type Frame,
  type RendererBackend,
  type TestHandle,
  type TestRenderOptions,
} from "./backend";
import { oscCopySelection } from "./osc";

function FrameApp(props: { frame: FrameState }) {
  return (
    <box width={props.frame.width} height={props.frame.height}>
      <For each={props.frame.lines}>{(line) => <text>{line}</text>}</For>
      {props.frame.hud !== undefined ? <text>{props.frame.hud}</text> : null}
    </box>
  );
}

function nativeUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /native|lib|zig|\.node|cannot find module/i.test(msg);
}

export class OpenTuiBackend implements RendererBackend {
  private destroyed = false;
  private mounted = false;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  readonly clipboard = {
    copy: (text: string): void => {
      this.assertAlive();
      process.stdout.write(oscCopySelection(text));
    },
  };

  private assertAlive(): void {
    if (this.destroyed) throw new Error("OpenTuiBackend: already destroyed");
  }

  render(frame: FrameState): Frame {
    this.assertAlive();
    const width = frame.width;
    const height = frame.height;
    const body = [...frame.lines];
    if (frame.hud !== undefined) body.push(frame.hud);
    const lines: string[] = [];
    for (let i = 0; i < height; i += 1) {
      const raw = body[i] ?? "";
      lines.push(raw.length > width ? raw.slice(0, width) : raw.padEnd(width, " "));
    }
    return { snapshot: lines.join("\n") };
  }

  mount(_options: BackendMountOptions): void {
    this.assertAlive();
    if (this.mounted) throw new Error("OpenTuiBackend: already mounted");
    this.mounted = true;
  }

  input(key: BackendKeyEvent): boolean {
    this.assertAlive();
    if (!this.mounted) throw new Error("OpenTuiBackend: not mounted");
    if (key.eventType === "release" || key.defaultPrevented) return false;
    let delivered = false;
    for (const listener of [...this.listeners]) {
      listener({ type: "key", key });
      delivered = true;
    }
    return delivered;
  }

  event(listener: (event: BackendEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  resize(size: BackendSize): void {
    this.assertAlive();
    for (const listener of [...this.listeners]) listener({ type: "resize", size });
  }

  async testRender(app: () => FrameState, opts: TestRenderOptions): Promise<TestHandle> {
    let setup: Awaited<ReturnType<typeof openTuiTestRender>>;
    try {
      setup = await openTuiTestRender(() => <FrameApp frame={app()} /> as never, {
        width: opts.width,
        height: opts.height,
      });
    } catch (err) {
      if (nativeUnavailable(err)) {
        const message = "OpenTUI native 不可用（testRender 已跳过，非降级后端）";
        throw new Error(message, { cause: err });
      }
      throw err;
    }

    let destroyed = false;
    return {
      async renderOnce() {
        if (destroyed) throw new Error("testRender handle: already destroyed");
        await setup.renderOnce();
      },
      captureCharFrame() {
        if (destroyed) throw new Error("testRender handle: already destroyed");
        return setup.captureCharFrame();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        setup.renderer.destroy();
      },
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
  }
}
