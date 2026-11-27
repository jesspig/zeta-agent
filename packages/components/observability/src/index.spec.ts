import { describe, expect, test } from "bun:test";
import {
  createEffectBridge,
  createLogger,
  getActiveEffectBridge,
  redact,
  setActiveEffectBridge,
  resolveLogSink,
  spansFromEffectMeta,
  type EffectMeta,
  type LogMessage,
} from "./index";

const sample: LogMessage = {
  fiberUid: "f-1",
  runId: "run-1",
  level: "info",
  message: "event",
};

describe("T-19 observability", () => {
  test("fiber 归因：日志携带 fiberUid/runId/level/message", () => {
    const messages: LogMessage[] = [];
    const logger = createLogger({ runId: "run-7", sink: (message) => messages.push(message) });

    logger.forFiber("fiber-7").info("hello");
    logger.forFiber("fiber-7").warn("careful");

    expect(messages).toHaveLength(2);
    expect(messages[0]!.fiberUid).toBe("fiber-7");
    expect(messages[0]!.runId).toBe("run-7");
    expect(messages[0]!.level).toBe("info");
    expect(messages[0]!.message).toBe("hello");
    expect(messages[1]!.level).toBe("warn");
  });

  test("effect 元树映射为 span 树，parentId 保持父子关系", () => {
    const meta: EffectMeta = {
      label: "root",
      children: [
        { label: "child-a", children: [{ label: "grand", children: [] }] },
        { label: "child-b", children: [] },
      ],
    };

    const spans = spansFromEffectMeta(meta);

    expect(spans.map((span) => span.name)).toEqual(["root", "child-a", "grand", "child-b"]);
    expect(spans[0]!.parentId).toBeNull();
    expect(spans[1]!.parentId).toBe(spans[0]!.spanId);
    expect(spans[2]!.parentId).toBe(spans[1]!.spanId);
    expect(spans[3]!.parentId).toBe(spans[0]!.spanId);
  });

  test("源头脱敏命中：rule 的 match/replace 作用于写入 sink 之前的消息", () => {
    const messages: LogMessage[] = [];
    const logger = createLogger({ runId: "r", sink: (message) => messages.push(message) });
    const stop = logger.addRedactor({ match: /sk-[A-Za-z0-9]+/g, replace: "[REDACTED]" });

    logger.forFiber("f").info("token sk-abc123 present");
    expect(messages[0]!.message).toBe("token [REDACTED] present");
    expect(messages[0]!.message.includes("sk-abc123")).toBe(false);

    stop();
    logger.forFiber("f").info("token sk-abc123 present");
    expect(messages[1]!.message.includes("sk-abc123")).toBe(true);
  });

  test("redact 纯函数：字符串 match 全部替换，正则 match 全局替换，不改输入", () => {
    const input = "a=1,a=2";
    expect(redact(input, [{ match: "a", replace: "X" }])).toBe("X=1,X=2");
    expect(redact("sk-1 sk-2", [{ match: /sk-\d/g, replace: "[R]" }])).toBe("[R] [R]");
    expect(input).toBe("a=1,a=2");
  });

  test("effect bridge 注册/广播/撤销 handler", () => {
    const bridge = createEffectBridge();
    const seen: string[] = [];
    const stop = bridge.onEffect((meta) => seen.push(meta.label));

    bridge.emit({ label: "root", children: [] });
    expect(seen).toEqual(["root"]);

    stop();
    bridge.emit({ label: "again", children: [] });
    expect(seen).toEqual(["root"]);
  });

  test("active effect bridge 安装/读取/恢复，runId 随 bridge 透传", () => {
    expect(getActiveEffectBridge()).toBeUndefined();
    const bridge = createEffectBridge("run-9");
    const restore = setActiveEffectBridge(bridge);
    expect(getActiveEffectBridge()).toBe(bridge);

    const seen: EffectMeta[] = [];
    const stop = bridge.onEffect((meta) => seen.push(meta));
    getActiveEffectBridge()!.emit({
      label: "root",
      runId: bridge.runId,
      fiberUid: "fiber-9",
      children: [],
    });
    expect(seen[0]!.runId).toBe("run-9");
    expect(seen[0]!.fiberUid).toBe("fiber-9");
    stop();

    restore();
    expect(getActiveEffectBridge()).toBeUndefined();
  });

  test("OTLP 配置失败降级本地 file sink，同步及异步发送抛错也降级", async () => {
    const otlpSends: LogMessage[] = [];
    const fileWrites: LogMessage[] = [];
    const healthy = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: (message) => otlpSends.push(message) },
      file: { write: (message) => fileWrites.push(message) },
    });

    expect(healthy.mode).toBe("otlp");
    healthy.sink(sample);
    expect(otlpSends).toHaveLength(1);
    expect(fileWrites).toHaveLength(0);

    const invalid = resolveLogSink({
      endpoint: "not-a-url",
      exporter: { export: async (message) => { otlpSends.push(message); return { ok: true } as const; } },
      file: { write: (message) => fileWrites.push(message) },
    });
    expect(invalid.mode).toBe("file");
    invalid.sink(sample);
    expect(fileWrites).toHaveLength(1);

    const flaky = resolveLogSink({
      endpoint: "https://otel.example.com/v1/logs",
      exporter: { export: async () => { throw new Error("OTLP_DOWN"); } },
      file: { write: (message) => fileWrites.push(message) },
    });
    expect(flaky.mode).toBe("otlp");
    flaky.sink(sample);
    await Bun.sleep(0);
    expect(fileWrites).toHaveLength(2);
  });
});
