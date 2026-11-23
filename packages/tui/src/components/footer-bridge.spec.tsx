import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";
import { FooterBridge } from "./footer-bridge";
import type { FooterMetrics } from "./footer";

function bus() {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

describe("U-03 真实状态栏", () => {
  test("status/statusMessage 随 agent 事件变化，不再恒为 ready/idle", async () => {
    const source = bus();
    const setup = await testRender(() => <FooterBridge source={source} />, {
      width: 60,
      height: 3,
    });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("idle");
      expect(setup.captureCharFrame()).not.toContain("ready");

      source.emit({ type: "agent_start" });
      await Bun.sleep(0);
      await setup.waitForFrame((frame) => frame.includes("streaming"));

      source.emit({ type: "turn_start" });
      await Bun.sleep(0);
      await setup.waitForFrame((frame) => frame.includes("working"));

      source.emit({ type: "turn_end", message: { role: "assistant", content: "ok" } as never, toolResults: [] });
      source.emit({ type: "agent_end", messages: [] });
      await Bun.sleep(0);
      await setup.waitForFrame((frame) => frame.includes("idle") && !frame.includes("working"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("budget 与 token/cost/branch/session 来自真实遥测（帧快照）", async () => {
    const metrics: FooterMetrics = {
      inputTokens: 64000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 0,
      costUsd: 0.42,
    };
    const setup = await testRender(
      () => (
        <FooterBridge
          model="gpt-4"
          telemetry={{
            pwd: "/home/jesspig/project",
            home: "/home/jesspig",
            branch: "feature/facade-assembly",
            session: "zeta-123",
            metrics,
            provider: "openai",
            modelId: "gpt-4",
          }}
        />
      ),
      { width: 100, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("ctx 50%"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("~/project");
      expect(frame).toContain("feature/facade-assembly");
      expect(frame).toContain("zeta-123");
      expect(frame).toContain("64k");
      expect(frame).toContain("$0.42");
      expect(frame).toContain("openai/gpt-4");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("无遥测时预算如实显示 0%，不再按消息数估算", async () => {
    const source = bus();
    const setup = await testRender(() => <FooterBridge source={source} />, {
      width: 60,
      height: 3,
    });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("ctx 0%");
      const messages = Array.from({ length: 10 }, () => ({ role: "user", content: "x" }));
      source.emit({ type: "agent_end", messages: messages as never });
      await Bun.sleep(0);
      expect(setup.captureCharFrame()).toContain("ctx 0%");
    } finally {
      setup.renderer.destroy();
    }
  });
});
