export type OscKind = "progress" | "status";

const OSC_7501 = "7501";
const OSC_9_4 = "9;4";

/** OSC 133：消息边界 prompt 标记。A=prompt 开始，B=prompt 结束。 */
export function oscPromptMark(mark: "A" | "B"): string {
  return `\x1b]133;${mark}\x1b\\`;
}

/** OSC 52：选择即复制，c=clipboard；文本以 base64 编码。 */
export function oscCopySelection(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${encoded}\x1b\\`;
}

const OSC_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const OSC_SAFE_SCHEMES = new Set(["http:", "https:"]);
const OSC_PARAM_KEY = /^[a-zA-Z0-9_-]+$/;

function normalizeHyperlinkUri(uri: string): string {
  if (typeof uri !== "string" || uri.length === 0 || OSC_CONTROL_CHARS.test(uri)) {
    throw new Error("INVALID_OSC_URI");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("INVALID_OSC_URI");
  }
  if (!OSC_SAFE_SCHEMES.has(parsed.protocol)) throw new Error("INVALID_OSC_URI");
  return encodeURI(uri);
}

/** OSC 8：超链接；params 为可选的 key=value 参数（如 id）。 */
export function oscHyperlink(uri: string, params: Readonly<Record<string, string>> = {}): string {
  const safeUri = normalizeHyperlinkUri(uri);
  const entries = Object.entries(params).map(([key, value]) => {
    if (!OSC_PARAM_KEY.test(key) || typeof value !== "string" || OSC_CONTROL_CHARS.test(value)) {
      throw new Error("INVALID_OSC_PARAMS");
    }
    return `${key}=${encodeURIComponent(value)}`;
  });
  const prefix = entries.length > 0 ? `${entries.join(":")}:` : "";
  return `\x1b]8;;${prefix}${safeUri}\x1b\\`;
}

/** 提取 Markdown 内联链接 URL，供产线渲染时触发 OSC 8 超链接。 */
export function extractMarkdownLinks(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const url = match[1];
    if (url !== undefined && url.length > 0) urls.push(url);
  }
  return urls;
}

export interface KittyModifiers {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly super: boolean;
}

/** Kitty 修饰键 mode 位掩码：1=shift, 2=alt/meta, 4=ctrl, 8=super, 16=hyper/option。 */
export function parseKittyModifiers(mode: number): KittyModifiers {
  return {
    shift: (mode & 1) !== 0,
    meta: (mode & 2) !== 0,
    ctrl: (mode & 4) !== 0,
    super: (mode & 8) !== 0,
    option: (mode & 16) !== 0,
  };
}

export { formatPasteBlock, foldLargePaste } from "./paste";

/** 构造 OSC 控制序列（7501 进度、9;4 工作状态），不直接依赖 native。 */
export function oscSequence(kind: OscKind, value: string | number): string {
  if (kind === "progress") {
    return `\x1b]${OSC_7501};${String(value)}\x1b\\`;
  }
  const state = value === "working" || value === "busy" ? 1 : 0;
  return `\x1b]${OSC_9_4};${state}\x1b\\`;
}

import type { AgentSignals } from "./signal";

export interface OscReporter {
  reportProgress(percent: number): void;
  reportStatus(status: string): void;
  /** OSC 133：prompt 开始/结束边界。 */
  markPrompt(mark: "A" | "B"): void;
  /** OSC 52：选择即复制。 */
  copySelection(text: string): void;
  /** OSC 8：超链接。 */
  link(uri: string, params?: Readonly<Record<string, string>>): void;
}

/** OSC 上报封装：写入函数可注入以便 spy，native 不可用时传入 no-op。 */
export function createOscReporter(
  write: (sequence: string) => void,
  onError: (error: unknown) => void = () => {},
): OscReporter {
  return {
    reportProgress(percent) {
      write(oscSequence("progress", Math.max(0, Math.min(100, percent))));
    },
    reportStatus(status) {
      write(oscSequence("status", status));
    },
    markPrompt(mark) {
      write(oscPromptMark(mark));
    },
    copySelection(text) {
      write(oscCopySelection(text));
    },
    link(uri, params) {
      try {
        write(oscHyperlink(uri, params));
      } catch (error) {
        onError(error);
      }
    },
  };
}

/** 把 agent 状态桥接到 OSC：status 变化时上报工作状态，消息增长时上报粗略进度。返回解除订阅函数。 */
export function createOscBridge(signals: AgentSignals, write: (sequence: string) => void): () => void {
  const reporter = createOscReporter(write);
  reporter.markPrompt("A");
  const offStatus = signals.status.subscribe((status) => {
    reporter.reportStatus(status === "idle" ? "done" : "working");
    if (status === "idle") reporter.markPrompt("B");
  });
  const offMessages = signals.messages.subscribe((messages) => {
    reporter.reportProgress(Math.min(100, messages.length * 2));
  });
  return () => {
    offStatus();
    offMessages();
    reporter.markPrompt("B");
    reporter.reportStatus("done");
  };
}
