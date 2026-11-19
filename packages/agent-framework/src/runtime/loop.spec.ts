import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent, type AgentMessage } from "./agent";
import { createInbox } from "./inbox";
import {
  RUN_LOOP_STEPS,
  runLoop,
  type AssistantResult,
  type ToolCall,
  type ToolResult,
} from "./loop";

const userMessage: AgentMessage = { role: "user", content: "question" };
const assistantMessage: AgentMessage = { role: "assistant", content: "calling tool" };
const toolCall: ToolCall = { id: "call-1", name: "tool", args: {} };
const toolResultMessage: AgentMessage = { role: "toolResult", content: "done" };

function harness() {
  const stream = createEventStream();
  const order: string[] = [];
  stream.subscribe((event: AgentEvent) => {
    order.push(event.type);
  });
  const inbox = createInbox();
  inbox.followUp(userMessage);
  return { stream, order, inbox };
}

describe("T-14 runLoop 11 步流水线", () => {
  test("流水线定义恰好 11 步", () => {
    expect(RUN_LOOP_STEPS).toHaveLength(11);
  });

  test("单轮含一次工具调用按序 emit AgentEvent 并在 agent_end 结束", async () => {
    const { stream, order, inbox } = harness();
    const assistantResult: AssistantResult = {
      message: assistantMessage,
      toolCalls: [toolCall],
      stopReason: "stop",
      updates: [{ type: "text_delta", delta: "calling" }],
    };
    const toolResults: ToolResult[] = [{
      callId: toolCall.id,
      message: toolResultMessage,
      updates: [{ partialResult: "partial" }],
    }];
    let streamCount = 0;

    await runLoop({
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      prepareRequest: () => ({ prompt: "x" }),
      streamAssistant: async () => {
        streamCount += 1;
        return assistantResult;
      },
      executeToolCalls: async () => toolResults,
      finishTurn: () => ({ action: "end" }),
    });

    expect(streamCount).toBe(1);
    expect(order).toEqual([
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  test("error/aborted 属硬退出：finishTurn 返回 continue 也只请求一次", async () => {
    const { stream, order, inbox } = harness();
    let streamCount = 0;

    await runLoop({
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      streamAssistant: async () => {
        streamCount += 1;
        return { message: assistantMessage, toolCalls: [], stopReason: "error" };
      },
      executeToolCalls: async () => [],
      finishTurn: () => ({ action: "continue" }),
    });

    expect(streamCount).toBe(1);
    expect(order).toEqual([
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });
});
