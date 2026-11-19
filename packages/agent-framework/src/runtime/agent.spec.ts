import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENT_TYPES,
  createEventStream,
  createInitialState,
  reduceState,
  type AgentEvent,
  type AgentMessage,
} from "./agent";

const userMessage: AgentMessage = { role: "user", content: "hi" };
const assistantMessage: AgentMessage = { role: "assistant", content: "ok" };

describe("T-13 AgentEvent 与订阅屏障", () => {
  test("AgentEvent 恰好 10 个变体且含 3 个独立 tool_execution 事件", () => {
    expect(AGENT_EVENT_TYPES).toHaveLength(10);
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(10);
    expect(AGENT_EVENT_TYPES.filter((type) => type.startsWith("tool_execution_"))).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    const baseTypes: readonly AgentEvent["type"][] = ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end"];
    for (const type of baseTypes) {
      expect(AGENT_EVENT_TYPES).toContain(type);
    }
  });

  test("reduceState 先归约状态且不改动原 state", () => {
    const initial = createInitialState();
    const streaming = reduceState(initial, { type: "message_start", message: assistantMessage });
    expect(streaming.isStreaming).toBe(true);
    expect(streaming.streamingMessage).toEqual(assistantMessage);

    const settled = reduceState(streaming, { type: "message_end", message: assistantMessage });
    expect(settled.isStreaming).toBe(false);
    expect(settled.streamingMessage).toBeUndefined();
    expect(settled.messages).toEqual([assistantMessage]);

    const pending = reduceState(settled, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "tool",
      args: {},
    });
    expect([...pending.pendingToolCalls]).toEqual(["call-1"]);

    const done = reduceState(pending, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "tool",
      result: "value",
      isError: false,
    });
    expect(done.pendingToolCalls.size).toBe(0);

    const ended = reduceState(done, { type: "agent_end", messages: [userMessage] });
    expect(ended.messages).toEqual([userMessage]);
    expect(done.messages).toEqual([assistantMessage]);
    expect(done).not.toBe(ended);
  });

  test("listener 在 state 归约之后才被调用", () => {
    const stream = createEventStream();
    let observedStreaming: boolean | undefined;
    stream.subscribe(() => {
      observedStreaming = stream.getState().isStreaming;
    });
    void stream.emit({ type: "message_start", message: assistantMessage });
    expect(observedStreaming).toBe(true);
  });

  test("subscribe 按注册顺序 await；agent_end listener 未完成时 waitForIdle 不 resolve", async () => {
    const stream = createEventStream();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    stream.subscribe(async (event: AgentEvent) => {
      order.push(`a:${event.type}`);
      if (event.type === "agent_end") await gate;
    });
    stream.subscribe((event: AgentEvent) => {
      order.push(`b:${event.type}`);
    });

    const emitted = stream.emit({ type: "agent_end", messages: [] });
    await Promise.resolve();
    expect(order).toEqual(["a:agent_end"]);

    let idleResolved = false;
    const idle = stream.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    release();
    await emitted;
    await idle;
    expect(idleResolved).toBe(true);
    expect(order).toEqual(["a:agent_end", "b:agent_end"]);
  });

  test("无在途事件时 waitForIdle 立即 resolve", async () => {
    await expect(createEventStream().waitForIdle()).resolves.toBeUndefined();
  });
});
