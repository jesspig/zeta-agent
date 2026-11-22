import { describe, expect, test } from "bun:test";
import { createInbox } from "./inbox";
import { runLoop, type LoopRuntime, type ToolResult } from "./loop";
import { createEventStream, type AgentEvent } from "./agent";

/** CR-17：完成通知按完成顺序，transcript 按 assistant 声明顺序。 */
describe("T-16 工具完成顺序与 transcript 顺序解耦", () => {
  test("results 反序时消息提交仍按 toolCalls 声明顺序", async () => {
    const inbox = createInbox();
    const stream = createEventStream();
    const events: AgentEvent[] = [];
    stream.subscribe((e) => { events.push(e); });
    const calls = [
      { id: "c1", name: "t", args: {} },
      { id: "c2", name: "t", args: {} },
    ];
    const results: ToolResult[] = [
      { callId: "c2", message: { role: "toolResult", content: "second" } },
      { callId: "c1", message: { role: "toolResult", content: "first" } },
    ];
    const runtime: LoopRuntime = {
      inbox,
      emit: (e) => stream.emit(e),
      getState: () => stream.getState(),
      streamAssistant: async () => ({
        message: { role: "assistant", content: "r" },
        toolCalls: calls,
        stopReason: "stop",
      }),
      executeToolCalls: async () => results,
      finishTurn: () => ({ action: "end" }),
    };
    await runLoop(runtime);
    const endIds = events.filter((e) => e.type === "tool_execution_end").map((e) => (e as { toolCallId: string }).toolCallId);
    const transcriptContents = events
      .filter((e) => e.type === "message_end" && e.message.role === "toolResult")
      .map((e) => String((e as { message: { content: unknown } }).message.content));
    expect(endIds).toEqual(["c2", "c1"]); // 完成顺序
    expect(transcriptContents).toEqual(["first", "second"]); // 声明顺序（c1->first, c2->second）
  });
});
