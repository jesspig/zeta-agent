import { setActiveEffectObserver, type Disposer, type EffectMeta, type EffectObserver } from "@zeta-agent/cordis";

export type { EffectMeta, EffectObserver } from "@zeta-agent/cordis";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogMessage {
  readonly fiberUid: string;
  readonly runId: string;
  readonly level: LogLevel;
  readonly message: string;
}

export interface RedactRule {
  readonly match: RegExp | string;
  readonly replace: string;
}

export type LogSink = (message: LogMessage) => void;

export interface FiberLogger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface Logger {
  readonly runId: string;
  forFiber(fiberUid: string): FiberLogger;
  addRedactor(rule: RedactRule): Disposer;
}

export interface LoggerOptions {
  readonly runId: string;
  readonly sink: LogSink;
  readonly redactors?: readonly RedactRule[];
}

export interface Span {
  readonly spanId: string;
  readonly parentId: string | null;
  readonly name: string;
}

export interface OtlpExporter {
  export(message: LogMessage): void;
}

export interface FileSink {
  write(message: LogMessage): void;
}

export interface SinkOptions {
  readonly endpoint: string;
  readonly exporter: OtlpExporter;
  readonly file: FileSink;
}

export interface SinkResolution {
  readonly mode: "otlp" | "file";
  readonly sink: LogSink;
}

export function redact(message: string, rules: readonly RedactRule[]): string {
  let result = message;
  for (const rule of rules) {
    if (typeof rule.match === "string") {
      result = result.split(rule.match).join(rule.replace);
      continue;
    }
    const flags = rule.match.flags.includes("g") ? rule.match.flags : `${rule.match.flags}g`;
    result = result.replace(new RegExp(rule.match.source, flags), rule.replace);
  }
  return result;
}

export function createLogger(options: LoggerOptions): Logger {
  const rules: RedactRule[] = [...(options.redactors ?? [])];

  const emit = (fiberUid: string, level: LogLevel, message: string): void => {
    options.sink({
      fiberUid,
      runId: options.runId,
      level,
      message: redact(message, rules),
    });
  };

  return {
    runId: options.runId,
    forFiber(fiberUid: string): FiberLogger {
      return {
        error: (message) => emit(fiberUid, "error", message),
        warn: (message) => emit(fiberUid, "warn", message),
        info: (message) => emit(fiberUid, "info", message),
        debug: (message) => emit(fiberUid, "debug", message),
      };
    },
    addRedactor(rule: RedactRule): Disposer {
      rules.push(rule);
      return () => {
        const index = rules.indexOf(rule);
        if (index >= 0) rules.splice(index, 1);
      };
    },
  };
}

export interface EffectBridge extends EffectObserver {
  onEffect(handler: (meta: EffectMeta) => void): Disposer;
}

export function createEffectBridge(runId?: string): EffectBridge {
  const handlers = new Set<(meta: EffectMeta) => void>();
  return {
    runId,
    onEffect(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(meta) {
      for (const handler of [...handlers]) handler(meta);
    },
  };
}

let activeEffectBridge: EffectBridge | undefined;

/** 安装全局 effect 观测桥，返回恢复上一次安装的逆；传 null 关闭观测。 */
export function setActiveEffectBridge(bridge: EffectBridge | null): Disposer {
  const previous = activeEffectBridge;
  activeEffectBridge = bridge ?? undefined;
  const restoreObserver = setActiveEffectObserver(bridge);
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    restoreObserver();
    activeEffectBridge = previous;
  };
}

/** effect 执行路径读取当前观测桥；未安装时返回 undefined，执行路径直接走无观测分支。 */
export function getActiveEffectBridge(): EffectBridge | undefined {
  return activeEffectBridge;
}

export function spansFromEffectMeta(meta: EffectMeta): Span[] {
  const spans: Span[] = [];

  const visit = (node: EffectMeta, spanId: string, parentId: string | null): void => {
    spans.push({ spanId, parentId, name: node.label });
    node.children.forEach((child, index) => visit(child, `${spanId}.${index}`, spanId));
  };

  visit(meta, "0", null);
  return spans;
}

export function resolveLogSink(options: SinkOptions): SinkResolution {
  let reachable = false;
  try {
    new URL(options.endpoint);
    reachable = true;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    return { mode: "file", sink: (message) => options.file.write(message) };
  }

  return {
    mode: "otlp",
    sink: (message) => {
      try {
        options.exporter.export(message);
      } catch {
        options.file.write(message);
      }
    },
  };
}
