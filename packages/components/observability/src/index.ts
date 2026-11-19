import type { Disposer } from "@zeta-agent/framework";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogMessage {
  readonly fiberUid: string;
  readonly runId: string;
  readonly level: LogLevel;
  readonly message: string;
}

export interface EffectMeta {
  readonly label: string;
  children: EffectMeta[];
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
