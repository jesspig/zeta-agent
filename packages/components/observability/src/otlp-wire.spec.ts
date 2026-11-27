import { describe, expect, test } from "bun:test";
import { createEffectHost } from "@zeta-agent/cordis";
import {
  createEffectBridge,
  createOtlpHttpExporter,
  createOtlpSpanExporter,
  createSpanCollector,
  createTelemetryPipeline,
  resolveLogSink,
  type LogMessage,
  type OtlpSpan,
  type TelemetryPipeline,
} from "./index";

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: string;
}

async function fixture(): Promise<{
  url: string;
  captured: () => Promise<Captured>;
  dispose: () => void;
}> {
  let resolveCaptured: ((value: Captured) => void) | undefined;
  const pending = new Promise<Captured>((resolve) => {
    resolveCaptured = resolve;
  });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      resolveCaptured?.({
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        body,
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    captured: () => pending,
    dispose: () => server.stop(true),
  };
}

const message: LogMessage = {
  fiberUid: "fiber-wire",
  runId: "run-wire",
  level: "warn",
  message: "wire reaches collector",
};

describe("T-22 OTLP/HTTP 真实 wire 与 sink 旁路", () => {
  test("logs exporter 向本地 fixture 发出真实 POST，字节含完整 OTLP JSON", async () => {
    const server = await fixture();
    try {
      const exporter = createOtlpHttpExporter({ endpoint: `${server.url}/v1/logs` });
      const result = await exporter.export(message);
      expect(result.ok).toBe(true);
      const captured = await server.captured();
      expect(captured.method).toBe("POST");
      expect(captured.path).toBe("/v1/logs");
      expect(captured.contentType).toBe("application/json");
      const payload = JSON.parse(captured.body);
      const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
      expect(record.body.stringValue).toBe("wire reaches collector");
      expect(record.severityText).toBe("WARN");
      expect(record.attributes.map((item: { key: string }) => item.key)).toContain("fiber.uid");
    } finally {
      server.dispose();
    }
  });

  test("traces exporter 真实 POST，body 含 span 树与 parentSpanId", async () => {
    const server = await fixture();
    try {
      const exporter = createOtlpSpanExporter({ endpoint: `${server.url}/v1/traces` });
      const spans: OtlpSpan[] = [
        {
          traceId: "a".repeat(32),
          spanId: "1".repeat(16),
          name: "root",
          startTimeUnixNano: "1",
          endTimeUnixNano: "2",
        },
        {
          traceId: "a".repeat(32),
          spanId: "2".repeat(16),
          parentSpanId: "1".repeat(16),
          name: "child",
          startTimeUnixNano: "3",
          endTimeUnixNano: "4",
        },
      ];
      const result = await exporter.export(spans);
      expect(result.ok).toBe(true);
      const captured = await server.captured();
      expect(captured.path).toBe("/v1/traces");
      const sent = JSON.parse(captured.body).resourceSpans[0].scopeSpans[0].spans;
      expect(sent.map((item: { name: string }) => item.name)).toEqual(["root", "child"]);
      expect(sent[1].parentSpanId).toBe("1".repeat(16));
    } finally {
      server.dispose();
    }
  });

  test("异步 503 与网络失败返回明确结果并通过 onAsyncFailure 暴露", async () => {
    const failures: string[] = [];
    const logs = createOtlpHttpExporter({
      endpoint: "https://otel.example.com/v1/logs",
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      onAsyncFailure: (error) => failures.push(error.message),
    });
    const logResult = await logs.export(message);
    expect(logResult.ok).toBe(false);
    if (!logResult.ok) {
      expect(logResult.retryable).toBe(true);
      expect(logResult.status).toBe(503);
    }

    const spans = createOtlpSpanExporter({
      endpoint: "https://otel.example.com/v1/traces",
      fetchImpl: (async () => { throw new Error("OTLP_NETWORK_DOWN"); }) as unknown as typeof fetch,
      onAsyncFailure: (error) => failures.push(error.message),
    });
    const spanResult = await spans.export([
      { traceId: "a".repeat(32), spanId: "1".repeat(16), name: "root", startTimeUnixNano: "1", endTimeUnixNano: "2" },
    ]);
    expect(spanResult.ok).toBe(false);
    if (!spanResult.ok) expect(spanResult.retryable).toBe(true);
    expect(failures).toContain("OTLP_EXPORT_FAILED: 503");
    expect(failures).toContain("OTLP_NETWORK_DOWN");
  });

  test("retry 分类：429/502/503/504 可重试，其他 4xx 永久失败", async () => {
    for (const status of [429, 502, 503, 504]) {
      const exporter = createOtlpHttpExporter({
        endpoint: "https://otel.example.com/v1/logs",
        fetchImpl: (async () => new Response("", { status })) as unknown as typeof fetch,
      });
      const result = await exporter.export(message);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const exporter = createOtlpHttpExporter({
        endpoint: "https://otel.example.com/v1/logs",
        fetchImpl: (async () => new Response("", { status })) as unknown as typeof fetch,
      });
      const result = await exporter.export(message);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(false);
    }
  });

  test("真实 fetch 收到 AbortSignal，超时返回可重试结果", async () => {
    let signal: AbortSignal | null | undefined;
    const exporter = createOtlpHttpExporter({
      endpoint: "https://otel.example.com/v1/logs",
      timeoutMs: 5,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("ABORTED", "AbortError")), { once: true });
        });
      }) as typeof fetch,
    });
    const result = await exporter.export(message);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error.message).toContain("TIMEOUT");
    }
  });

  test("resolveLogSink 对真实 exporter 的异步 503 失败落 file", async () => {
    const files: LogMessage[] = [];
    const sink = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: createOtlpHttpExporter({
        endpoint: "https://otel.example.com/v1/logs",
        fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      }),
      file: { write: (item) => files.push(item) },
    });
    sink.sink(message);
    await Bun.sleep(0);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual(message);
  });

  test("sink 故障旁路：exporter 抛错时 resolveLogSink 落 file，主流程不中断", async () => {
    const files: LogMessage[] = [];
    const sink = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: async () => { throw new Error("OTLP_DOWN"); } },
      file: { write: (item) => files.push(item) },
    });
    expect(() => sink.sink(message)).not.toThrow();
    await Bun.sleep(0);
    expect(files).toHaveLength(1);
    expect(files[0]!.message).toBe("wire reaches collector");
  });

  test("真实 effect 树经 observer 转成 span；观测 handler 抛错被旁路", () => {
    const bridge = createEffectBridge("run-spans");
    const seen: string[] = [];
    bridge.onEffect((meta) => seen.push(meta.label));
    bridge.onEffect(() => { throw new Error("OBSERVER_BROKEN"); });

    const collector = createSpanCollector({ bridge });
    const host = createEffectHost("fiber-spans", bridge);
    expect(() => {
      host.effect((child) => {
        child.effect(() => () => {}, "effect.child");
        return () => {};
      }, "effect.root");
    }).not.toThrow();

    expect(seen).toContain("effect.root");
    expect(seen).not.toContain("effect.child");
    // observer 只收到根 meta，但 span 采集器展开真实子树，得到 root + child。
    expect(collector.spans().map((span) => span.name)).toEqual(["effect.root", "effect.child"]);
    expect(collector.spans()[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(collector.spans()[0]!.parentSpanId).toBeUndefined();
    expect(collector.spans()[1]!.parentSpanId).toBe(collector.spans()[0]!.spanId);
    expect(collector.spans()[1]!.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(collector.spans()[1]!.parentSpanId).not.toBe("0".repeat(16));
  });

  test("span exporter 故障时采集仍保留 span，不阻断主流程", () => {
    const bridge = createEffectBridge("run-fail");
    const collector = createSpanCollector({
      bridge,
      failingExporter: { export: async () => { throw new Error("SPAN_SINK_DOWN"); } },
    });
    expect(() => bridge.emit({ label: "root", children: [{ label: "child", children: [] }] })).not.toThrow();
    expect(collector.spans().map((span) => span.name)).toEqual(["root", "child"]);
  });

  test("同步 exporter 的 void 与 ExportResult 保持兼容", async () => {
    const files: LogMessage[] = [];
    const syncVoid = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: () => {} },
      file: { write: (item) => files.push(item) },
    });
    syncVoid.sink(message);
    const syncOk = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: () => ({ ok: true }) },
      file: { write: (item) => files.push(item) },
    });
    syncOk.sink(message);
    const syncFailure = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: () => ({ ok: false, retryable: false, error: new Error("SYNC_BAD_REQUEST") }) },
      file: { write: (item) => files.push(item) },
    });
    syncFailure.sink(message);
    const syncSends: LogMessage[] = [];
    const pushShorthand = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: (item) => syncSends.push(item) },
      file: { write: (item) => files.push(item) },
    });
    pushShorthand.sink(message);
    const otherSyncValue = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: () => 42 },
      file: { write: (item) => files.push(item) },
    });
    otherSyncValue.sink(message);
    expect(syncSends).toEqual([message]);
    expect(files).toEqual([message]);

    const failures: Error[] = [];
    const voidBridge = createEffectBridge("sync-void");
    let syncCalls = 0;
    const voidCollector = createSpanCollector({
      bridge: voidBridge,
      exporter: { export: () => syncCalls += 1 },
      onExportFailure: (error) => failures.push(error),
    });
    voidBridge.emit({ label: "root", children: [] });
    await voidCollector.flush();
    expect(syncCalls).toBe(1);
    expect(failures).toEqual([]);

    const resultBridge = createEffectBridge("sync-result");
    const resultCollector = createSpanCollector({
      bridge: resultBridge,
      exporter: { export: () => ({ ok: false, retryable: false, error: new Error("SYNC_SPAN_FAILURE") }) },
      onExportFailure: (error) => failures.push(error),
    });
    resultBridge.emit({ label: "root", children: [] });
    await resultCollector.flush();
    expect(failures.map((error) => error.message)).toEqual(["SYNC_SPAN_FAILURE"]);
  });

  test("collector maxPendingBatches 限制异步 exporter 在途批次", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const failures: Error[] = [];
    const bridge = createEffectBridge("pending-limit");
    const collector = createSpanCollector({
      bridge,
      maxPendingBatches: 2,
      exporter: {
        async export() {
          calls += 1;
          await gate;
          return { ok: true };
        },
      },
      onExportFailure: (error) => failures.push(error),
    });
    bridge.emit({ label: "one", children: [] });
    bridge.emit({ label: "two", children: [] });
    bridge.emit({ label: "three", children: [] });
    expect(calls).toBe(2);
    expect(failures.map((error) => error.message)).toEqual(["TELEMETRY_SPAN_EXPORT_QUEUE_FULL"]);
    expect(collector.spans()).toHaveLength(3);
    release?.();
    await collector.flush();
  });

  test("collector maxPendingBatches 同时限制 pipeline enqueueTail", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enqueued = 0;
    const failures: Error[] = [];
    const pipeline: TelemetryPipeline<OtlpSpan> = {
      maxQueueSize: 4,
      maxBatchSize: 2,
      maxInFlight: 1,
      async start() {},
      async recover() { return 0; },
      async enqueue() {
        enqueued += 1;
        await gate;
        return true;
      },
      async flush() { await gate; },
      async shutdown() {},
      stats() { return { queueSize: 0, inFlightSize: 0, maxInFlight: 1, accepting: true }; },
    };
    const bridge = createEffectBridge("enqueue-tail-limit");
    const collector = createSpanCollector({
      bridge,
      pipeline,
      maxPendingBatches: 2,
      onExportFailure: (error) => failures.push(error),
    });
    bridge.emit({ label: "one", children: [] });
    bridge.emit({ label: "two", children: [] });
    bridge.emit({ label: "three", children: [] });
    await Bun.sleep(0);
    expect(enqueued).toBe(1);
    expect(failures.map((error) => error.message)).toEqual(["TELEMETRY_SPAN_EXPORT_QUEUE_FULL"]);
    release?.();
    await collector.flush();
    expect(enqueued).toBe(2);
  });

  test("collector 经有界 pipeline 排队，flush 等待全部 span 导出", async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstExportStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const exported: OtlpSpan[] = [];
    const pipeline = createTelemetryPipeline<OtlpSpan>({
      maxQueueSize: 4,
      maxBatchSize: 2,
      exporter: {
        async export(spans) {
          exported.push(...spans);
          markStarted?.();
          await gate;
          return { ok: true };
        },
      },
    });
    const bridge = createEffectBridge("run-pipeline");
    const collector = createSpanCollector({ bridge, pipeline, maxRecordedSpans: 2 });
    try {
      bridge.emit({ label: "root", children: [{ label: "child", children: [] }, { label: "leaf", children: [] }] });
      expect(collector.spans().map((span) => span.name)).toEqual(["child", "leaf"]);
      const flushing = collector.flush();
      await firstExportStarted;
      expect(exported).toHaveLength(1);
      release?.();
      await flushing;
      expect(exported.map((span) => span.name)).toEqual(["root", "child", "leaf"]);
    } finally {
      release?.();
      collector.dispose();
      await pipeline.shutdown();
    }
  });
});
