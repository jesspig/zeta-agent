import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AssistantMessageEvent,
} from "./agent";
import type {
  AgentDecision,
  DecisionWaterfall,
} from "./decision";
import { nextAction } from "./decision";
import type { Inbox } from "./inbox";

export type LoopDecision =
  | { readonly action: "continue" }
  | { readonly action: "end" };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface AssistantResult {
  readonly message: AgentMessage;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: "stop" | "length" | "error" | "aborted";
  readonly updates?: readonly AssistantMessageEvent[];
}

export interface ToolExecutionUpdate {
  readonly partialResult: unknown;
}

export interface ToolResult {
  readonly callId: string;
  readonly message: AgentMessage;
  readonly isError?: boolean;
  readonly updates?: readonly ToolExecutionUpdate[];
}

export interface LastTurn {
  readonly message: AgentMessage;
  readonly toolResults: readonly AgentMessage[];
}

export interface LoopRuntime {
  readonly inbox: Inbox;
  emit(event: AgentEvent): Promise<void> | void;
  getState(): AgentState;
  prepareNextTurn?(lastTurn: LastTurn | undefined): void;
  prepareRequest?(request: unknown): unknown;
  streamAssistant(request: unknown, onPartial?: (message: AgentMessage) => void | Promise<void>): Promise<AssistantResult>;
  executeToolCalls(calls: readonly ToolCall[]): Promise<readonly ToolResult[]>;
  finishTurn?(turn: LastTurn): LoopDecision | undefined;
  decide?(state: AgentState, turn: LastTurn): LoopDecision;
  decision?(state: AgentState, turn: LastTurn): AgentDecision;
  waterfall?: DecisionWaterfall;
  pollFollowUp?(): readonly AgentMessage[];
}

export const RUN_LOOP_STEPS = [
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
] as const;

async function resolveAction(
  runtime: LoopRuntime,
  turn: LastTurn,
  toolCallCount: number
): Promise<"continue" | "end"> {
  const legacy = runtime.finishTurn?.(turn);
  if (legacy) return legacy.action;
  const legacyDecision = runtime.decide?.(runtime.getState(), turn);
  if (legacyDecision) return legacyDecision.action;
  if (runtime.decision || runtime.waterfall) {
    const state = runtime.getState();
    const initial = runtime.decision?.(state, turn) ?? nextAction(state);
    const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
    const decided = runtime.waterfall
      ? await runtime.waterfall.run(initial, { state, event })
      : initial;
    return decided.kind === "exit" ? "end" : "continue";
  }
  return toolCallCount > 0 ? "continue" : "end";
}

export async function runLoop(runtime: LoopRuntime): Promise<AgentState> {
  const { inbox, emit } = runtime;
  let lastTurn: LastTurn | undefined;
  let explicitContinuation = false;
  let ended = false;

  async function emitAgentEnd(): Promise<void> {
    if (ended) return;
    ended = true;
    await emit({ type: "agent_end", messages: runtime.getState().messages });
  }

  while (true) {
    runtime.prepareNextTurn?.(lastTurn);
    const steering = inbox.poll("nextTurn");
    await emit({ type: "turn_start" });

    for (const item of steering) {
      await emit({ type: "message_start", message: item.body });
      await emit({ type: "message_end", message: item.body });
    }

    const request = runtime.prepareRequest?.({ messages: runtime.getState().messages }) ?? {
      messages: runtime.getState().messages,
    };

    await emit({ type: "message_start", message: { role: "assistant", content: "" } });
    const response = await runtime.streamAssistant(request, async (partial) => {
      await emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", delta: partial.content },
      });
    });
    for (const update of response.updates ?? []) {
      await emit({ type: "message_update", message: response.message, assistantMessageEvent: update });
    }
    await emit({ type: "message_end", message: response.message });

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const turn: LastTurn = { message: response.message, toolResults: [] };
      runtime.finishTurn?.(turn);
      await emit({ type: "turn_end", message: response.message, toolResults: [] });
      await emitAgentEnd();
      return runtime.getState();
    }

    const toolCalls = response.toolCalls;
    let results: readonly ToolResult[] = [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
      }
      results = response.stopReason === "length"
        ? toolCalls.map((call) => ({
            callId: call.id,
            message: { role: "toolResult" as const, content: "truncated" },
            isError: true,
          }))
        : await runtime.executeToolCalls(toolCalls);
      for (const result of results) {
        for (const update of result.updates ?? []) {
          await emit({
            type: "tool_execution_update",
            toolCallId: result.callId,
            toolName: "",
            args: {},
            partialResult: update.partialResult,
          });
        }
        await emit({
          type: "tool_execution_end",
          toolCallId: result.callId,
          toolName: "",
          result: result.message.content,
          isError: result.isError ?? false,
        });
      }
    }

    const toolResultMessages = results.map((result) => result.message);
    for (const message of toolResultMessages) {
      await emit({ type: "message_start", message });
      await emit({ type: "message_end", message });
    }
    const turn: LastTurn = { message: response.message, toolResults: toolResultMessages };
    const action = await resolveAction(runtime, turn, toolCalls.length);
    await emit({ type: "turn_end", message: response.message, toolResults: toolResultMessages });
    lastTurn = turn;

    if (action === "end") {
      await emitAgentEnd();
      return runtime.getState();
    }

    const moreSteering = inbox.poll("nextTurn");
    explicitContinuation = toolCalls.length === 0 && moreSteering.length === 0;

    // 决策为 continue（例如模型请求了原生工具调用）时必须进入下一轮，
    // 让工具结果回到模型；否则会在一轮后静默结束。
    if (action === "continue") continue;

    const followUps = runtime.pollFollowUp?.() ?? inbox.poll("nextTurn");
    if (followUps.length > 0) continue;
    if (explicitContinuation) continue;
    break;
  }

  await emitAgentEnd();
  return runtime.getState();
}
