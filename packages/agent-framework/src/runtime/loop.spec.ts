import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent, type AgentMessage } from "./agent";
import { createInbox } from "./inbox";
import {
  RUN_LOOP_STEPS,
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopRuntime,
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
  inbox.steer(userMessage);
  return { stream, order, inbox };
}

describe("T-14 runLoop 11 步流水线", () => {
  test("流水线定义恰好 11 步且顺序固定", () => {
    // 不靠长度凑数：逐项断言 11 步名称与顺序；真实进入顺序由下一条 onStep 探针校验。
    expect(RUN_LOOP_STEPS).toEqual([
      "prepareNextTurn",
      "declareToolChanges",
      "prepareRequest",
      "streamAssistant",
      "hardExitCheck",
      "executeToolCalls",
      "appendToolResultsAndFinishTurn",
      "decisionEnd",
      "decisionContinue",
      "outerFollowUpOrBreak",
      "emitAgentEnd",
    ]);
  });

  test("11 步按设计顺序真实进入（onStep 探针）", async () => {
    // 首轮无 lastCompletedTurn：不进入 step1；次轮有 lastCompletedTurn：
    // 从 prepareNextTurn 起完整走完 RUN_LOOP_STEPS 的 11 步。
    const stream = createEventStream();
    const entered: string[] = [];
    const inbox = createInbox();
    let streamCount = 0;

    await runLoop({
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      declareToolChanges: () => [{ role: "system", content: "tools: read" }],
      prepareRequest: () => ({ prompt: "x" }),
      onStep: (step) => entered.push(step),
      streamAssistant: async () => {
        streamCount += 1;
        return { message: assistantMessage, toolCalls: [toolCall], stopReason: "stop" };
      },
      executeToolCalls: async () => [{ callId: toolCall.id, message: toolResultMessage }],
      finishTurn: () => ({ action: streamCount < 2 ? "continue" : "end" }),
    });

    expect(streamCount).toBe(2);
    const firstTurn = RUN_LOOP_STEPS.filter((step) => step !== "prepareNextTurn" && step !== "emitAgentEnd");
    expect(entered.slice(0, firstTurn.length)).toEqual([...firstTurn]);
    expect(entered.slice(firstTurn.length)).toEqual([...RUN_LOOP_STEPS]);
  });

  test("无 lastCompletedTurn：不进入 step1（无 prepareNextTurn 探针、无第二次 turn_start）", async () => {
    const stream = createEventStream();
    const entered: string[] = [];
    const prepareArgs: Array<LastTurn | undefined> = [];
    const turnStarts: number[] = [];
    let streamCount = 0;
    const runtime: LoopRuntime = {
      inbox: createInbox(),
      emit: (event) => {
        if (event.type === "turn_start") turnStarts.push(streamCount);
        return stream.emit(event);
      },
      getState: () => stream.getState(),
      prepareNextTurn: (turn) => { prepareArgs.push(turn); },
      onStep: (step) => entered.push(step),
      streamAssistant: async () => {
        streamCount += 1;
        return { message: assistantMessage, toolCalls: [], stopReason: "stop" };
      },
      finishTurn: () => ({ action: "end" }),
    };

    await runLoop(runtime);

    expect(streamCount).toBe(1);
    // 首轮的 prepareNextTurn?.(undefined) 是 A6 #4 兼容调用，不属 step1：无探针、不轮询、不发 turn_start。
    expect(prepareArgs).toEqual([]);
    expect(entered).not.toContain("prepareNextTurn");
    expect(turnStarts).toEqual([0]); // 仅进入 runLoop 前那一次
    expect(entered.slice(0, -1)).toEqual(
      [...RUN_LOOP_STEPS].filter((step) => step !== "prepareNextTurn" && step !== "emitAgentEnd")
    );
  });

  test("有 lastCompletedTurn：才执行 step1（prepareNextTurn(lastTurn) + 第二次 turn_start）", async () => {
    const stream = createEventStream();
    const entered: string[] = [];
    const prepareArgs: Array<LastTurn | undefined> = [];
    const turnStarts: number[] = [];
    let streamCount = 0;
    const runtime: LoopRuntime = {
      inbox: createInbox(),
      emit: (event) => {
        if (event.type === "turn_start") turnStarts.push(streamCount);
        return stream.emit(event);
      },
      getState: () => stream.getState(),
      prepareNextTurn: (turn) => { prepareArgs.push(turn); },
      onStep: (step) => entered.push(step),
      streamAssistant: async () => {
        streamCount += 1;
        return { message: { role: "assistant", content: `r${streamCount}` }, toolCalls: [], stopReason: "stop" };
      },
      finishTurn: () => ({ action: streamCount < 2 ? "continue" : "end" }),
    };

    await runLoop(runtime);

    expect(streamCount).toBe(2);
    expect(prepareArgs).toHaveLength(1);
    expect(prepareArgs[0]).toEqual({ message: { role: "assistant", content: "r1" }, toolResults: [] });
    expect(entered.filter((step) => step === "prepareNextTurn")).toHaveLength(1); // 仅次轮进入 step1
    expect(turnStarts).toEqual([0, 1]); // 首轮前置 emit + 次轮 step1 emit
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
