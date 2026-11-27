import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectBridge, createFileTelemetrySpool, type OtlpSpan } from "@zeta-agent/observability";
import { createAgent } from "./facade";

function activeBackend() {
  const capabilities = {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  } as const;
  return {
    name: "span-active-backend",
    capabilities: () => capabilities,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
    dispose: () => {},
  };
}

const streamFn = async function* () {};

describe("T-22 facade per-agent observer 与真实 effect span", () => {
  test("默认不注入 observer：spans() 为空且 useContext() 保持 undefined", async () => {
    const agent = createAgent({ includeBuiltins: false, streamFn, securityBackend: activeBackend() });
    expect(agent.spans()).toEqual([]);
    expect(agent.api.useContext()).toBeUndefined();
    await agent.dispose();
  });

  test("显式启用后真实工具调用生成 span，per-agent observer 互不串用", async () => {
    const bridgeA = createEffectBridge("run-a");
    const bridgeB = createEffectBridge("run-b");
    const agentA = createAgent({
      includeBuiltins: false,
      streamFn,
      securityBackend: activeBackend(),
      observabilitySpans: true,
      effectBridge: bridgeA,
    });
    const agentB = createAgent({
      includeBuiltins: false,
      streamFn,
      securityBackend: activeBackend(),
      observabilitySpans: true,
      effectBridge: bridgeB,
    });
    try {
      expect(agentA.api.useContext()).toBeDefined();
      const result = await agentA.runTool({ name: "observed-tool", execute: () => "ok" });
      expect(result).toEqual({ ok: true, value: "ok" });

      const spans = agentA.spans();
      expect(spans.map((span) => span.name)).toContain("tool:observed-tool");
      expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(agentB.spans()).toEqual([]);
    } finally {
      await agentA.dispose();
      await agentB.dispose();
    }
  });

  test("observer 故障旁路：观测 handler 抛错不影响工具主流程", async () => {
    const bridge = createEffectBridge("run-broken");
    bridge.onEffect(() => { throw new Error("OBSERVER_BROKEN"); });
    const agent = createAgent({
      includeBuiltins: false,
      streamFn,
      securityBackend: activeBackend(),
      observabilitySpans: true,
      effectBridge: bridge,
    });
    try {
      const result = await agent.runTool({ name: "resilient", execute: () => "still-ok" });
      expect(result).toEqual({ ok: true, value: "still-ok" });
      expect(agent.spans().map((span) => span.name)).toContain("tool:resilient");
    } finally {
      await agent.dispose();
    }
  });

  test("启动时恢复 spool 并兼容同步 span exporter", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-facade-telemetry-recovery-"));
    const path = join(root, "telemetry.jsonl");
    const seed = createFileTelemetrySpool<OtlpSpan>({ path });
    await seed.enqueue({
      traceId: "a".repeat(32),
      spanId: "1".repeat(16),
      name: "recovered-span",
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
    });
    await seed.close();
    let markExported: (() => void) | undefined;
    const exported = new Promise<void>((resolve) => { markExported = resolve; });
    const delivered: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn,
      securityBackend: activeBackend(),
      observabilitySpans: true,
      telemetrySpoolPath: path,
      spanExporter: {
        export(spans) {
          delivered.push(...spans.map((span) => span.name));
          markExported?.();
        },
      },
    });
    try {
      await exported;
      expect(delivered).toEqual(["recovered-span"]);
    } finally {
      await agent.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dispose 等待异步 span exporter 刷新已接受 span", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exported: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn,
      securityBackend: activeBackend(),
      observabilitySpans: true,
      spanExporter: {
        async export(spans) {
          exported.push(...spans.map((span) => span.name));
          await gate;
          return { ok: true };
        },
      },
    });
    try {
      await agent.runTool({ name: "flush-on-dispose", execute: () => "ok" });
      const disposing = agent.dispose();
      let settled = false;
      void disposing.then(() => { settled = true; });
      await Bun.sleep(0);
      expect(settled).toBe(false);
      release?.();
      await disposing;
      expect(exported).toContain("tool:flush-on-dispose");
    } finally {
      release?.();
      await agent.dispose();
    }
  });
});
