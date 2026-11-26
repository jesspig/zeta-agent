import { describe, expect, test } from "bun:test";
import { createEffectHost } from "@zeta-agent/cordis";
import {
  createEffectBridge,
  createOtlpHttpExporter,
  createOtlpSpanExporter,
  createSpanCollector,
  resolveLogSink,
  type LogMessage,
  type OtlpSpan,
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
      exporter.export(message);
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
      exporter.export(spans);
      const captured = await server.captured();
      expect(captured.path).toBe("/v1/traces");
      const sent = JSON.parse(captured.body).resourceSpans[0].scopeSpans[0].spans;
      expect(sent.map((item: { name: string }) => item.name)).toEqual(["root", "child"]);
      expect(sent[1].parentSpanId).toBe("1".repeat(16));
    } finally {
      server.dispose();
    }
  });

  test("sink 故障旁路：exporter 抛错时 resolveLogSink 落 file，主流程不中断", () => {
    const files: LogMessage[] = [];
    const sink = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: () => { throw new Error("OTLP_DOWN"); } },
      file: { write: (item) => files.push(item) },
    });
    expect(() => sink.sink(message)).not.toThrow();
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
    expect(collector.spans()[1]!.parentSpanId).toBeDefined();
  });

  test("span exporter 故障时采集仍保留 span，不阻断主流程", () => {
    const bridge = createEffectBridge("run-fail");
    const collector = createSpanCollector({
      bridge,
      failingExporter: { export: () => { throw new Error("SPAN_SINK_DOWN"); } },
    });
    expect(() => bridge.emit({ label: "root", children: [{ label: "child", children: [] }] })).not.toThrow();
    expect(collector.spans().map((span) => span.name)).toEqual(["root", "child"]);
  });
});
