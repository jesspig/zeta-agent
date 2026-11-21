import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@zeta-agent/agent";
import {
  createAgentSignals,
  createSignal,
} from "./signal";

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

describe("T-03 AgentSignals 扩展与事件顺序不变量", () => {
  test("message_update partial 快照在 awaited listener 之前已更新到 signal", async () => {
    const source = bus();
    const signals = createAgentSignals(source);
    const partial = { role: "assistant", content: "partial-text" } as const;
    const observedAtAwait: string[] = [];

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.subscribe(async (event: AgentEvent) => {
      if (event.type !== "message_update") return;
      await gate;
      observedAtAwait.push(String(signals.streaming()?.content ?? ""));
    });

    source.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", content: "partial-text" },
    });
    await Promise.resolve();
    expect(observedAtAwait).toEqual([]);

    release();
    await gate;
    await Promise.resolve();
    expect(observedAtAwait).toEqual(["partial-text"]);
    expect(signals.streaming()?.content).toBe("partial-text");
  });

  test("工具完成顺序（pendingTools）与 transcript 源码顺序（completedTools）解耦", () => {
    const source = bus();
    const signals = createAgentSignals(source);
    const completionOrder: string[] = [];
    signals.pendingTools.subscribe((ids) => {
      if (!ids.has("c1") && !ids.has("c2")) return;
      completionOrder.push([...ids].join(","));
    });

    source.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    source.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "write", args: {} });

    source.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "write", result: "ok2", isError: false, durationMs: 2 });
    expect(signals.pendingTools().has("c2")).toBe(false);
    expect(signals.pendingTools().has("c1")).toBe(true);
    const toolC2 = signals.toolStates().get("c2");
    expect(toolC2?.status).toBe("done");
    expect(toolC2?.durationMs).toBe(2);

    source.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "ok1", isError: false, durationMs: 1 });
    expect(signals.pendingTools().size).toBe(0);
    expect(completionOrder).toEqual(["c1", "c1,c2", "c1"]);

    const r1: AgentMessage = { role: "toolResult", content: "ok1" };
    const r2: AgentMessage = { role: "toolResult", content: "ok2" };
    const turnMessage: AgentMessage = { role: "assistant", content: "done" };
    source.emit({ type: "turn_end", message: turnMessage, toolResults: [r1, r2] });
    expect(signals.completedTools().map((m) => m.content)).toEqual(["ok1", "ok2"]);
  });

  test("thinking 与 statusMessage 信号按 thinking/status 事件更新", () => {
    const source = bus();
    const signals = createAgentSignals(source);

    source.emit({
      type: "message_update",
      message: { role: "assistant", content: { type: "thinking", text: "思考中" } },
      assistantMessageEvent: { type: "thinking", text: "思考中" },
    });
    expect(signals.thinking()).toBe("思考中");

    source.emit({
      type: "message_end",
      message: { role: "assistant", content: "final" },
    });
    expect(signals.thinking()).toBe("");

    expect(signals.statusMessage()).toBeNull();
  });

  test("toolStates 状态涵盖 running/done/error，且不与 pendingTools 冲突", () => {
    const source = bus();
    const signals = createAgentSignals(source);

    source.emit({ type: "tool_execution_start", toolCallId: "e1", toolName: "bad", args: { x: 1 } });
    let state = signals.toolStates().get("e1");
    expect(state?.name).toBe("bad");
    expect(state?.status).toBe("running");
    expect(state?.args).toEqual({ x: 1 });

    source.emit({ type: "tool_execution_update", toolCallId: "e1", toolName: "bad", args: { x: 2 }, partialResult: "p" });
    state = signals.toolStates().get("e1");
    expect(state?.args).toEqual({ x: 2 });

    source.emit({ type: "tool_execution_end", toolCallId: "e1", toolName: "bad", result: "failed", isError: true });
    state = signals.toolStates().get("e1");
    expect(state?.status).toBe("error");
    expect(signals.pendingTools().size).toBe(0);
  });
});
