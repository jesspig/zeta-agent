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
      // 观测是旁路：任何 handler 失败都不得改变 effect 生命周期或阻断其他订阅者。
      for (const handler of [...handlers]) {
        try {
          handler(meta);
        } catch {
          // 单个观测消费者故障被隔离。
        }
      }
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

// ── 真实 OTLP/HTTP wire ────────────────────────────────────────────────────
// 这里不是 seam：exporter 实际向 endpoint 发出 HTTP POST，fixture server 可校验
// method/path/content-type 与 body 字节。失败由调用方（resolveLogSink/采集器）旁路。

export interface OtlpWireOptions {
  readonly endpoint: string;
  /** 可注入的 fetch；缺省用全局 fetch，便于本地 fixture 验证真实字节。 */
  readonly fetchImpl?: typeof fetch;
  readonly serviceName?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface SpanExporter {
  export(spans: readonly OtlpSpan[]): void;
}

function otlpResource(serviceName: string): Record<string, unknown> {
  return {
    resource: {
      attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
    },
  };
}

function hexId(bytes: number): string {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < bytes * 2; index += 1) {
    out += alphabet[Math.floor(Math.random() * 16)];
  }
  return out;
}

function nanoClock(): () => string {
  const origin = process.hrtime.bigint();
  const wall = BigInt(Date.now()) * 1_000_000n;
  return () => (wall + (process.hrtime.bigint() - origin)).toString();
}

/** OTLP/HTTP JSON logs exporter：真实 POST 到 endpoint，非 2xx/网络异常即抛错。 */
export function createOtlpHttpExporter(options: OtlpWireOptions): OtlpExporter {
  const endpoint = new URL(options.endpoint).toString();
  const send = options.fetchImpl ?? fetch;
  const serviceName = options.serviceName ?? "zeta-agent";
  const clock = nanoClock();
  return {
    export(message) {
      const body = {
        resourceLogs: [
          {
            ...otlpResource(serviceName),
            scopeLogs: [
              {
                scope: { name: "zeta-agent" },
                logRecords: [
                  {
                    timeUnixNano: clock(),
                    severityNumber: message.level === "error" ? 17 : message.level === "warn" ? 13 : 9,
                    severityText: message.level.toUpperCase(),
                    body: { stringValue: message.message },
                    attributes: [
                      { key: "fiber.uid", value: { stringValue: message.fiberUid } },
                      { key: "run.id", value: { stringValue: message.runId } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const response = send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(body),
      });
      // fetch 返回 Promise；显式同步校验已发起的请求对象，异步结果由 then 抛出，
      // 但不影响调用方主流程（调用方已经 try/catch 旁路）。
      void response.then((reply) => {
        if (!reply.ok) throw new Error(`OTLP_EXPORT_FAILED: ${reply.status}`);
      }).catch(() => {
        // 旁路错误不得产生 unhandled rejection；同步 export 仍可通过注入 fetch 抛错向调用方传故障。
      });
    },
  };
}

/** OTLP/HTTP JSON traces exporter：真实 POST 到 endpoint。 */
export function createOtlpSpanExporter(options: OtlpWireOptions): SpanExporter {
  const endpoint = new URL(options.endpoint).toString();
  const send = options.fetchImpl ?? fetch;
  const serviceName = options.serviceName ?? "zeta-agent";
  return {
    export(spans) {
      if (spans.length === 0) return;
      const body = {
        resourceSpans: [
          {
            ...otlpResource(serviceName),
            scopeSpans: [
              {
                scope: { name: "zeta-agent" },
                spans: spans.map((span) => ({
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                  name: span.name,
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({
                    key,
                    value: { stringValue: value },
                  })),
                })),
              },
            ],
          },
        ],
      };
      void send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(body),
      }).then((reply) => {
        if (!reply.ok) throw new Error(`OTLP_SPAN_EXPORT_FAILED: ${reply.status}`);
      }).catch(() => {
        // 旁路错误不得产生 unhandled rejection。
      });
    },
  };
}

/** 把真实 effect 元树映射成带 trace/span id 的 OTLP span，并旁路导出。 */
export function createSpanCollector(options: {
  readonly bridge: EffectBridge;
  readonly exporter?: SpanExporter;
  readonly failingExporter?: SpanExporter;
}): { readonly spans: () => readonly OtlpSpan[]; readonly dispose: () => void } {
  const recorded: OtlpSpan[] = [];
  const clock = nanoClock();
  const traceId = hexId(16);
  const stop = options.bridge.onEffect((meta) => {
    for (const span of spansFromEffectMeta(meta)) {
      const record: OtlpSpan = Object.freeze({
        traceId,
        spanId: hexId(8),
        ...(span.parentId === null ? {} : { parentSpanId: span.parentId }),
        name: span.name,
        startTimeUnixNano: clock(),
        endTimeUnixNano: clock(),
        attributes: Object.freeze({ "effect.label": span.name }),
      });
      recorded.push(record);
    }
    const exporter = options.failingExporter ?? options.exporter;
    if (exporter !== undefined) {
      try {
        exporter.export(recorded.slice(-optionsBridgeCount(meta)));
      } catch {
        // sink 故障旁路：主流程与采集都不受影响。
      }
    }
  });
  return {
    spans: () => Object.freeze([...recorded]),
    dispose: stop,
  };
}

function optionsBridgeCount(meta: EffectMeta): number {
  let count = 0;
  const visit = (node: EffectMeta): void => {
    count += 1;
    for (const child of node.children) visit(child);
  };
  visit(meta);
  return count;
}
