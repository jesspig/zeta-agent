import { testRender as renderFrame, type FrameState } from "./frame";
import { OpenTuiBackend } from "./backend-opentui";

export interface Frame {
  readonly snapshot: string;
}

export interface TestRenderOptions {
  readonly width: number;
  readonly height: number;
}

export interface TestHandle {
  renderOnce(): Promise<void>;
  captureCharFrame(): string;
  destroy(): void;
}

export interface RendererBackend {
  render(frame: FrameState): Frame;
  testRender(app: () => FrameState, opts: TestRenderOptions): Promise<TestHandle>;
  destroy(): void;
}

export interface TuiHandle {
  readonly backend: RendererBackend;
  render(frame: FrameState): Frame;
  destroy(): void;
}

export interface CreateTuiOptions {
  readonly backend?: RendererBackend;
}

export function frameSnapshot(handle: TestHandle): string {
  return handle.captureCharFrame();
}

export function createTui(options: CreateTuiOptions = {}): TuiHandle {
  const backend = options.backend ?? new OpenTuiBackend();
  return {
    backend,
    render: (frame) => backend.render(frame),
    destroy: () => backend.destroy(),
  };
}

export function createFrameRenderer(): Pick<RendererBackend, "render"> {
  return { render: (frame) => ({ snapshot: renderFrame(frame) }) };
}
