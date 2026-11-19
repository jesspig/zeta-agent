import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@zeta-agent/agent";
import { createAgentSignals, createSignal } from "./signal";

function bus() {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    subscribe(listener: (event: AgentEvent) => void) {
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

describe("T-27 agent event signal bridge", () => {
  test("createSignal reads, writes and notifies subscribers", () => {
    const count = createSignal(0);
    const seen: number[] = [];
    const dispose = count.subscribe((value) => {
      seen.push(value);
    });

    count.set(1);
    count.set(1);
    count.set(2);
    dispose();
    count.set(3);

    expect(count()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  test("agent events drive messages, streaming, tools and status signals", () => {
    const source = bus();
    const signals = createAgentSignals(source);
    const message = { role: "assistant", content: "hi" } as const;

    expect(signals.status()).toBe("idle");
    source.emit({ type: "agent_start" });
    expect(signals.status()).toBe("streaming");

    source.emit({ type: "message_start", message });
    expect(signals.streaming()?.content).toBe("hi");
    source.emit({ type: "message_end", message });
    expect(signals.streaming()).toBeNull();
    expect(signals.messages()).toHaveLength(1);

    source.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    expect(signals.pendingTools().has("c1")).toBe(true);
    expect(signals.status()).toBe("tool");
    source.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: "ok",
      isError: false,
    });
    expect(signals.pendingTools().size).toBe(0);
    expect(signals.status()).toBe("streaming");

    source.emit({ type: "agent_end", messages: [message] });
    expect(signals.status()).toBe("idle");
    expect(signals.streaming()).toBeNull();
  });

  test("dispose stops signal updates from the bridge", () => {
    const source = bus();
    const signals = createAgentSignals(source);
    signals.dispose();
    source.emit({ type: "agent_start" });
    expect(signals.status()).toBe("idle");
  });
});
