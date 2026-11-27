import { randomBytes } from "node:crypto";
import { setActiveEffectObserver, type Disposer, type EffectMeta, type EffectObserver } from "@zeta-agent/cordis";
import type { TelemetryPipeline } from "./pipeline";

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

export type ExportResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly retryable: boolean;
    readonly error: Error;
    readonly status?: number;
    readonly retryAfterMs?: number;
  };

export interface OtlpExporter {
  export(message: LogMessage): void;
}

export interface AsyncOtlpExporter extends OtlpExporter {
  export(message: LogMessage): Promise<ExportResult>;
}

export interface FileSink {
  write(message: LogMessage): void;
}

export interface SinkOptions {
  readonly endpoint: string;
  /** 真实 OTLP exporter 异步返回 ExportResult；同步 void/ExportResult seam 保持兼容。 */
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
      const fallback = (): void => {
        try {
          options.file.write(message);
        } catch {
          // file 旁路失败同样不能改变日志主流程。
        }
      };
      try {
        const exported: unknown = options.exporter.export(message);
        if (isPromiseLike<unknown>(exported)) {
          void Promise.resolve(exported).then(
            (result) => {
              if (isExportResult(result) && !result.ok) fallback();
            },
            () => fallback(),
          );
        } else if (isExportResult(exported) && !exported.ok) {
          fallback();
        }
      } catch {
        fallback();
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
  readonly timeoutMs?: number;
  /** 导出失败的可观测出口；结果仍由 export 的 Promise 明确返回。 */
  readonly onAsyncFailure?: (error: Error) => void;
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

export interface AsyncSpanExporter extends SpanExporter {
  export(spans: readonly OtlpSpan[]): Promise<ExportResult>;
}

function otlpResource(serviceName: string): Record<string, unknown> {
  return {
    resource: {
      attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
    },
  };
}

function hexId(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function nanoClock(): () => string {
  const origin = process.hrtime.bigint();
  const wall = BigInt(Date.now()) * 1_000_000n;
  return () => (wall + (process.hrtime.bigint() - origin)).toString();
}

const EXPORT_OK: ExportResult = Object.freeze({ ok: true });

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function";
}

function isExportResult(value: unknown): value is ExportResult {
  return typeof value === "object" && value !== null && "ok" in value &&
    typeof (value as { readonly ok?: unknown }).ok === "boolean";
}

function retryAfterMs(reply: Response): number | undefined {
  const value = reply.headers.get("retry-after");
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500 && status <= 599;
}

function reportAsyncFailure(options: OtlpWireOptions, error: Error): void {
  try {
    options.onAsyncFailure?.(error);
  } catch {
    // 观测回调故障不得改变 export 的明确结果。
  }
}

async function postOtlp(
  endpoint: string,
  body: unknown,
  options: OtlpWireOptions,
  failureCode: "OTLP_EXPORT_FAILED" | "OTLP_SPAN_EXPORT_FAILED",
): Promise<ExportResult> {
  const send = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("OTLP timeoutMs must be a positive finite number");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const reply = await send(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (reply.ok) return EXPORT_OK;
    const status = reply.status;
    const error = new Error(`${failureCode}: ${status}`);
    const retryAfter = retryAfterMs(reply);
    const result: ExportResult = {
      ok: false,
      retryable: isRetryableStatus(status),
      error,
      status,
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    };
    reportAsyncFailure(options, error);
    return result;
  } catch (cause) {
    const error = timedOut
      ? new Error(`${failureCode}: TIMEOUT`, { cause })
      : asError(cause);
    const result: ExportResult = { ok: false, retryable: true, error };
    reportAsyncFailure(options, error);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** OTLP/HTTP JSON logs exporter：真实 POST 到 endpoint，并返回明确投递结果。 */
export function createOtlpHttpExporter(options: OtlpWireOptions): AsyncOtlpExporter {
  const endpoint = new URL(options.endpoint).toString();
  const serviceName = options.serviceName ?? "zeta-agent";
  const clock = nanoClock();
  return {
    async export(message) {
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
      return postOtlp(endpoint, body, options, "OTLP_EXPORT_FAILED");
    },
  };
}

/** OTLP/HTTP JSON traces exporter：真实 POST 到 endpoint，并返回明确投递结果。 */
export function createOtlpSpanExporter(options: OtlpWireOptions): AsyncSpanExporter {
  const endpoint = new URL(options.endpoint).toString();
  const serviceName = options.serviceName ?? "zeta-agent";
  return {
    async export(spans) {
      if (spans.length === 0) return EXPORT_OK;
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
      return postOtlp(endpoint, body, options, "OTLP_SPAN_EXPORT_FAILED");
    },
  };
}

/** 把真实 effect 元树映射成带 trace/span id 的 OTLP span，并旁路导出。 */
export function createSpanCollector(options: {
  readonly bridge: EffectBridge;
  readonly exporter?: SpanExporter;
  readonly failingExporter?: SpanExporter;
  readonly pipeline?: TelemetryPipeline<OtlpSpan>;
  readonly maxRecordedSpans?: number;
  readonly maxPendingBatches?: number;
  readonly onExportFailure?: (error: Error) => void;
}): {
  readonly spans: () => readonly OtlpSpan[];
  readonly flush: () => Promise<void>;
  readonly dispose: () => void;
} {
  const maxRecordedSpans = options.maxRecordedSpans ?? 10_000;
  if (!Number.isSafeInteger(maxRecordedSpans) || maxRecordedSpans <= 0) {
    throw new RangeError("maxRecordedSpans must be a positive safe integer");
  }
  const maxPendingBatches = options.maxPendingBatches ?? 64;
  if (!Number.isSafeInteger(maxPendingBatches) || maxPendingBatches <= 0) {
    throw new RangeError("maxPendingBatches must be a positive safe integer");
  }
  const recorded: OtlpSpan[] = [];
  const pendingExports = new Set<Promise<void>>();
  const clock = nanoClock();
  const traceId = hexId(16);
  let enqueueTail = Promise.resolve();
  let pendingBatches = 0;
  const reportFailure = (error: unknown): void => {
    try {
      options.onExportFailure?.(asError(error));
    } catch {
      // span 导出失败不能反向影响 effect 生命周期。
    }
  };
  const remember = (record: OtlpSpan): void => {
    recorded.push(record);
    const overflow = recorded.length - maxRecordedSpans;
    if (overflow > 0) recorded.splice(0, overflow);
  };
  const stop = options.bridge.onEffect((meta) => {
    const spanIds = new Map<string, string>();
    const batch: OtlpSpan[] = [];
    for (const span of spansFromEffectMeta(meta)) {
      const spanId = hexId(8);
      spanIds.set(span.spanId, spanId);
      const parentSpanId = span.parentId === null ? undefined : spanIds.get(span.parentId);
      const record: OtlpSpan = Object.freeze({
        traceId,
        spanId,
        ...(parentSpanId === undefined ? {} : { parentSpanId }),
        name: span.name,
        startTimeUnixNano: clock(),
        endTimeUnixNano: clock(),
        attributes: Object.freeze({ "effect.label": span.name }),
      });
      remember(record);
      batch.push(record);
    }
    if (pendingBatches >= maxPendingBatches) {
      reportFailure(new Error("TELEMETRY_SPAN_EXPORT_QUEUE_FULL"));
      return;
    }
    const pipeline = options.pipeline;
    if (pipeline !== undefined) {
      pendingBatches += 1;
      enqueueTail = enqueueTail.then(async () => {
        for (const record of batch) {
          if (await pipeline.enqueue(record)) continue;
          reportFailure(new Error("TELEMETRY_PIPELINE_REJECTED"));
        }
      }).catch(reportFailure).finally(() => {
        pendingBatches -= 1;
      });
      return;
    }
    const exporter = options.failingExporter ?? options.exporter;
    if (exporter !== undefined) {
      try {
        const exported: unknown = exporter.export(batch);
        if (isPromiseLike<unknown>(exported)) {
          pendingBatches += 1;
          const pending = Promise.resolve(exported).then(
            (result) => {
              if (isExportResult(result) && !result.ok) reportFailure(result.error);
            },
            (error: unknown) => reportFailure(error),
          ).finally(() => {
            pendingBatches -= 1;
          });
          pendingExports.add(pending);
          void pending.finally(() => pendingExports.delete(pending));
        } else if (isExportResult(exported) && !exported.ok) {
          reportFailure(exported.error);
        }
      } catch (error) {
        reportFailure(error);
      }
    }
  });
  return {
    spans: () => Object.freeze([...recorded]),
    async flush() {
      await enqueueTail;
      if (options.pipeline !== undefined) await options.pipeline.flush();
      await Promise.allSettled([...pendingExports]);
    },
    dispose: stop,
  };
}

export * from "./pipeline";
export * from "./spool";
