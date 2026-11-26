import { describe, expect, test } from "bun:test";
import { createEffectBridge } from "@zeta-agent/observability";
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
});
