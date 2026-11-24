import type { FrameState } from "./frame-state";
import type { ScreenMode } from "./dual-mode";
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

/** 终端尺寸；resize 与 mount 共用，避免后端各自定义形状。 */
export interface BackendSize {
  readonly width: number;
  readonly height: number;
}

/** 与 Kitty/普通键盘事件字段对齐的规范化按键；调用方可阻止默认行为与冒泡。 */
export interface BackendKeyEvent {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
  readonly eventType?: "press" | "release" | "repeat";
  readonly defaultPrevented?: boolean;
  readonly propagationStopped?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface BackendMountOptions extends BackendSize {
  readonly screenMode?: ScreenMode;
  readonly useKittyKeyboard?: boolean;
}

/** 后端向上层派发的事件；上层只经 event() 订阅，不直接依赖终端实现。 */
export type BackendEvent =
  | { readonly type: "key"; readonly key: BackendKeyEvent }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "resize"; readonly size: BackendSize };

export interface BackendClipboard {
  /** OSC 52 复制；后端负责把文本写入其目标剪贴板。 */
  copy(text: string): void;
}

/** 可替换渲染后端：接管终端输出、输入、尺寸、剪贴板与销毁的完整生命周期。 */
export interface RendererBackend {
  render(frame: FrameState): Frame;
  /** 接管终端：分配资源、装配输入/尺寸监听。幂等；已销毁后拒绝。 */
  mount(options: BackendMountOptions): Promise<void> | void;
  /** 注入按键（原生转发或宿主模拟）；true 表示已派发给订阅者。 */
  input(event: BackendKeyEvent): boolean;
  /** 订阅后端事件；返回退订函数。 */
  event(listener: (event: BackendEvent) => void): () => void;
  /** 通知尺寸变化（SSH window-change、测试模拟等）。 */
  resize(size: BackendSize): void;
  /** 剪贴板能力。 */
  readonly clipboard: BackendClipboard;
  testRender(app: () => FrameState, opts: TestRenderOptions): Promise<TestHandle>;
  /** 释放全部资源；幂等，之后不得再接管。 */
  destroy(): void;
}

export interface TuiHandle {
  readonly backend: RendererBackend;
  render(frame: FrameState): Frame;
  mount(options: BackendMountOptions): Promise<void> | void;
  input(event: BackendKeyEvent): boolean;
  event(listener: (event: BackendEvent) => void): () => void;
  resize(size: BackendSize): void;
  readonly clipboard: BackendClipboard;
  destroy(): void;
}

export interface CreateTuiOptions {
  readonly backend?: RendererBackend;
}

/** 构造可注入 spy 的按键事件，供宿主转发与 conformance 测试共用。 */
export function createBackendKeyEvent(
  input: Omit<BackendKeyEvent, "preventDefault" | "stopPropagation" | "defaultPrevented" | "propagationStopped"> & {
    readonly onPreventDefault?: () => void;
    readonly onStopPropagation?: () => void;
  },
): BackendKeyEvent {
  const { onPreventDefault, onStopPropagation, ...fields } = input;
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    ...fields,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault() {
      defaultPrevented = true;
      onPreventDefault?.();
    },
    stopPropagation() {
      propagationStopped = true;
      onStopPropagation?.();
    },
  };
}

export function frameSnapshot(handle: TestHandle): string {
  return handle.captureCharFrame();
}

export function createTui(options: CreateTuiOptions = {}): TuiHandle {
  const backend = options.backend ?? new OpenTuiBackend();
  return {
    backend,
    render: (frame) => backend.render(frame),
    mount: (mountOptions) => backend.mount(mountOptions),
    input: (event) => backend.input(event),
    event: (listener) => backend.event(listener),
    resize: (size) => backend.resize(size),
    get clipboard() {
      return backend.clipboard;
    },
    destroy: () => backend.destroy(),
  };
}
