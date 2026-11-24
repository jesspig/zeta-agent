import type { BackendSize } from "./backend";

export type SupportedPlatform = "win32" | "darwin" | "linux";

export interface CapabilityInput {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** native（OpenTUI Zig 绑定）是否成功加载；由调用方探测，缺省视为不可用。 */
  readonly nativeAvailable?: boolean;
  /** 是否可分配真实 PTY；由调用方探测，缺省视为不可用。 */
  readonly ptyAvailable?: boolean;
}

export interface PlatformCapability {
  readonly platform: SupportedPlatform;
  readonly nativeAvailable: boolean;
  readonly ptyAvailable: boolean;
  /** 只跳过 native/PTY 相关测试；无头逻辑测试不受影响。 */
  readonly skipNativeTests: boolean;
  /** 无头模式永不依赖 native；该标志恒为 true。 */
  readonly headlessSafe: true;
  readonly termProgram?: string;
  readonly colorTerminal: boolean;
}

export function detectCapability(input: CapabilityInput = {}): PlatformCapability {
  const raw = input.platform ?? process.platform;
  const platform: SupportedPlatform = raw === "win32" || raw === "darwin" || raw === "linux" ? raw : "linux";
  const nativeAvailable = input.nativeAvailable === true;
  const ptyAvailable = input.ptyAvailable === true;
  const env = input.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const termProgram = env.TERM_PROGRAM;
  return {
    platform,
    nativeAvailable,
    ptyAvailable,
    skipNativeTests: !nativeAvailable || !ptyAvailable,
    headlessSafe: true,
    ...(termProgram !== undefined ? { termProgram } : {}),
    colorTerminal: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
  };
}

export function alternateScreenSequence(action: "enter" | "exit"): string {
  return action === "enter" ? "\x1b[?1049h" : "\x1b[?1049l";
}

/** xterm window-change 上报；resize 与 PTY 尺寸同步共用。 */
export function resizeSequence(size: BackendSize): string {
  if (!Number.isInteger(size.width) || size.width <= 0) throw new Error("width: expected a positive integer");
  if (!Number.isInteger(size.height) || size.height <= 0) throw new Error("height: expected a positive integer");
  return `\x1b[8;${size.height};${size.width}t`;
}

export function mouseTrackingSequence(enabled: boolean): string {
  return enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l";
}

export function kittyKeyboardSequence(enabled: boolean): string {
  return enabled ? "\x1b[>1u" : "\x1b[<u";
}

export function bracketedPasteSequence(enabled: boolean): string {
  return enabled ? "\x1b[?2004h" : "\x1b[?2004l";
}

/** 退出/异常恢复时复位光标键模式，避免宿主命令行留下应用程序光标键。 */
export function cursorKeyResetSequence(): string {
  return "\x1b[?1l\x1b>";
}

export type PtySessionState = "main" | "alternate" | "restored" | "abnormal";

export interface PtySessionHandle {
  state(): PtySessionState;
  enter(): void;
  resize(size: BackendSize): void;
  exit(): void;
  abnormalExit(): void;
  output(): string;
  reset(): void;
}

function assertState(session: PtySessionHandle, allowed: readonly PtySessionState[], action: string): void {
  if (!allowed.includes(session.state())) throw new Error(`PTY_STATE: ${action} not allowed in ${session.state()}`);
}

/** 平台无关的 PTY 会话状态机：正常退出与异常终止都保证终端协议被复位。 */
export function createPtySession(): PtySessionHandle {
  let state: PtySessionState = "main";
  let output = "";
  const session: PtySessionHandle = {
    state: () => state,
    enter() {
      assertState(session, ["main"], "enter");
      output += alternateScreenSequence("enter");
      output += kittyKeyboardSequence(true);
      output += mouseTrackingSequence(true);
      output += bracketedPasteSequence(true);
      state = "alternate";
    },
    resize(size) {
      assertState(session, ["alternate"], "resize");
      output += resizeSequence(size);
    },
    exit() {
      if (state === "restored") return;
      assertState(session, ["alternate"], "exit");
      output += bracketedPasteSequence(false);
      output += mouseTrackingSequence(false);
      output += kittyKeyboardSequence(false);
      output += cursorKeyResetSequence();
      output += alternateScreenSequence("exit");
      state = "restored";
    },
    abnormalExit() {
      if (state === "abnormal") return;
      assertState(session, ["alternate"], "abnormalExit");
      output += bracketedPasteSequence(false);
      output += mouseTrackingSequence(false);
      output += kittyKeyboardSequence(false);
      output += cursorKeyResetSequence();
      output += alternateScreenSequence("exit");
      state = "abnormal";
    },
    output: () => output,
    reset() {
      state = "main";
      output = "";
    },
  };
  return session;
}
