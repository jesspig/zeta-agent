import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@zeta-agent/agent";
import { createAgentSignals } from "./signal";
import { createOscBridge, oscSequence } from "./osc";

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

describe("U-05 OSC 状态上报接线", () => {
  test("序列构造正确（7501 进度、9;4 工作状态）", () => {
    expect(oscSequence("progress", 42)).toBe("\x1b]7501;42\x1b\\");
    expect(oscSequence("status", "working")).toBe("\x1b]9;4;1\x1b\\");
    expect(oscSequence("status", "done")).toBe("\x1b]9;4;0\x1b\\");
  });

  test("agent 事件驱动真实 OSC 上报，退出复位 done", () => {
    const source = bus();
    const signals = createAgentSignals(source);
    const written: string[] = [];
    const release = createOscBridge(signals, (seq) => written.push(seq));

    source.emit({ type: "agent_start" });
    expect(written).toContain("\x1b]9;4;1\x1b\\");

    source.emit({
      type: "message_end",
      message: { role: "user", content: "hi" } as never,
    });
    expect(written).toContain("\x1b]7501;2\x1b\\");

    release();
    expect(written.at(-1)).toBe("\x1b]9;4;0\x1b\\");
  });
});
