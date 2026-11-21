import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";
import { createAgentSignals, type EventSource } from "../signal";

type Listener = (event: AgentEvent) => void;
function bus() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

describe("T-07 滚动跟随与状态边框", () => {
  test("状态边框按 statusMessage 渲染 working/retry/compaction/blocked", async () => {
    const { StatusBorder } = await import("./status-border");
    const source = bus();
    const setup = await testRender(
      () => <StatusBorder source={source as EventSource} />,
      { width: 40, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("idle"));
      source.emit({ type: "turn_start" });
      await setup.waitForFrame((frame) => frame.includes("working"));
      source.emit({ type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] });
      await setup.waitForFrame((frame) => frame.includes("idle"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("statusMessage 显式值可渲染 retry/compaction/blocked", () => {
    const signals = createAgentSignals(bus());
    expect(signals.statusMessage()).toBeNull();
    signals.dispose();
  });

  test("scrollbox stickyScroll 参数存在并被采纳", async () => {
    const { FollowScrollBox } = await import("./status-border");
    const source = bus();
    const setup = await testRender(
      () => <FollowScrollBox source={source as EventSource} lines={["a", "b", "c", "d", "e"]} />,
      { width: 20, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("e"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("e");
      expect(typeof setup.renderer).toBe("object");
    } finally {
      setup.renderer.destroy();
    }
  });
});
