import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";
import { FooterBridge } from "./footer-bridge";

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

  test("budget 由消息数估算，非写死 0/1", async () => {
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
      await setup.waitForFrame((frame) => frame.includes("ctx 16%"));
    } finally {
      setup.renderer.destroy();
    }
  });
});
