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
import type { Inbox, InboxMessage } from "./inbox";
import type { ToolPipeline } from "../tools/pipeline";
import type {
  LoopToolCall,
  LoopToolResult,
  ToolDeclarationDelta,
  ToolExecutionUpdate,
} from "../tools/types";

export type { ToolExecutionUpdate } from "../tools/types";

export type LoopDecision =
  | { readonly action: "continue" }
  | { readonly action: "end" };

/** 旧 loop 调用形状别名：统一定义见 tools/types。 */
export type ToolCall = LoopToolCall;

export interface AssistantResult {
  readonly message: AgentMessage;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: "stop" | "length" | "error" | "aborted";
  readonly updates?: readonly AssistantMessageEvent[];
  readonly usage?: unknown;
  readonly durationMs?: number;
  readonly responseId?: string;
  readonly error?: unknown;
}

/** 旧 loop 结果形状别名：统一定义见 tools/types。 */
export type ToolResult = LoopToolResult;

export interface LastTurn {
  readonly message: AgentMessage;
  readonly toolResults: readonly AgentMessage[];
  readonly newMessages?: readonly AgentMessage[];
}

export interface LoopRuntime {
  readonly inbox: Inbox;
  readonly signal?: AbortSignal;
  emit(event: AgentEvent, signal?: AbortSignal): Promise<void> | void;
  getState(): AgentState;
  prepareNextTurn?(lastTurn: LastTurn | undefined, signal?: AbortSignal): unknown | Promise<unknown>;
  /** 工具声明 delta：返回 system 消息或 delta 对象，由 loop 统一 emit。 */
  declareToolChanges?(signal?: AbortSignal): readonly AgentMessage[] | ToolDeclarationDelta | void | Promise<readonly AgentMessage[] | ToolDeclarationDelta | void>;
  prepareRequest?(request: unknown, signal?: AbortSignal): unknown | Promise<unknown>;
  streamAssistant(request: unknown, onPartial?: (message: AgentMessage, signal?: AbortSignal) => void | Promise<void>, signal?: AbortSignal): Promise<AssistantResult>;
  executeToolCalls?(calls: readonly ToolCall[], signal?: AbortSignal): Promise<readonly ToolResult[]>;
  /** 提供时由统一 prepare/execute/finalize 管线执行工具，否则沿用 executeToolCalls。 */
  toolPipeline?: ToolPipeline;
  finishTurn?(turn: LastTurn, signal?: AbortSignal): LoopDecision | undefined | void | Promise<LoopDecision | undefined | void>;
  decide?(state: AgentState, turn: LastTurn): LoopDecision;
  decision?(state: AgentState, turn: LastTurn): AgentDecision;
  waterfall?: DecisionWaterfall;
  pollFollowUp?(signal?: AbortSignal): readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  /** 兼容开关：文本工具标记由上层可选解析，统一管线本身不依赖该协议。 */
  readonly allowTextToolMarkers?: boolean;
  /** 仅测试可见：按进入顺序记录 11 步流水线阶段，用于校验真实执行顺序。 */
  onStep?(step: string): void;
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
  toolCallCount: number,
  signal?: AbortSignal
): Promise<"continue" | "end"> {
  const legacy = await runtime.finishTurn?.(turn, signal);
  if (legacy !== undefined) return legacy.action;
  const legacyDecision = runtime.decide?.(runtime.getState(), turn);
  if (legacyDecision !== undefined) return legacyDecision.action;
  if (runtime.decision !== undefined || runtime.waterfall !== undefined) {
    const state = runtime.getState();
    const initial = runtime.decision?.(state, turn) ?? nextAction(state);
    const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
    let decided: AgentDecision = initial;
    if (runtime.waterfall !== undefined) {
      try {
        decided = await runtime.waterfall.run(initial, { state, event });
      } catch {
        decided = nextAction(state);
      }
    }
    return decided.kind === "exit" ? "end" : "continue";
  }
  return toolCallCount > 0 ? "continue" : "end";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLoop(runtime: LoopRuntime): Promise<AgentState> {
  const { inbox, signal } = runtime;
  const initialMessageCount = runtime.getState().messages.length;
  let lastTurn: LastTurn | undefined;
  let explicitContinuation = false;
  let ended = false;
  let enterInner = true;
  let hasMoreToolCalls = false;
  let pending: readonly InboxMessage[] = inbox.poll("nextTurn");

  const emit = async (event: AgentEvent): Promise<void> => {
    await runtime.emit(event, signal);
  };

  async function emitAgentEnd(): Promise<void> {
    if (ended) return;
    ended = true;
    runtime.onStep?.("emitAgentEnd");
    await emit({ type: "agent_end", messages: runtime.getState().messages.slice(initialMessageCount) });
  }

  await emit({ type: "turn_start" });

  while (true) {
    while (enterInner || pending.length > 0 || hasMoreToolCalls) {
      enterInner = false;
      if (lastTurn !== undefined) {
        runtime.onStep?.("prepareNextTurn");
        await runtime.prepareNextTurn?.(lastTurn, signal);
        pending = [...pending, ...inbox.poll("nextTurn")];
        await emit({ type: "turn_start" });
      }

      runtime.onStep?.("declareToolChanges");
      const declared = await runtime.declareToolChanges?.(signal);
      if (declared !== undefined) {
        const deltaMessages = "messages" in declared ? declared.messages : declared;
        for (const message of deltaMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
        }
      }

      for (const item of pending) {
        await emit({ type: "message_start", message: item.body });
        await emit({ type: "message_end", message: item.body });
      }
      pending = [];

      runtime.onStep?.("prepareRequest");
      const request = await runtime.prepareRequest?.({ messages: runtime.getState().messages }, signal)
        ?? { messages: runtime.getState().messages };

      runtime.onStep?.("streamAssistant");
      await emit({ type: "message_start", message: { role: "assistant", content: "" } });
      let response: AssistantResult;
      try {
        response = await runtime.streamAssistant(request, async (partial) => {
          await emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_delta", delta: partial.content },
          });
        }, signal);
      } catch (error) {
        response = {
          message: { role: "assistant", content: `Error: ${errorMessage(error)}` },
          toolCalls: [],
          stopReason: "error",
          error,
        };
      }
      for (const update of response.updates ?? []) {
        await emit({ type: "message_update", message: response.message, assistantMessageEvent: update });
      }
      await emit({ type: "message_end", message: response.message });

      runtime.onStep?.("hardExitCheck");
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        const turn: LastTurn = { message: response.message, toolResults: [] };
        await resolveAction(runtime, turn, 0, signal);
        await emit({ type: "turn_end", message: response.message, toolResults: [] });
        await emitAgentEnd();
        return runtime.getState();
      }

      runtime.onStep?.("executeToolCalls");
      const toolCalls = response.toolCalls;
      let results: readonly ToolResult[] = [];
      if (toolCalls.length > 0) {
        if (response.stopReason === "length") {
          results = toolCalls.map((call) => ({
            callId: call.id,
            message: { role: "toolResult", content: "truncated", toolCallId: call.id, toolName: call.name },
            isError: true,
          }));
        } else if (runtime.toolPipeline !== undefined) {
          const pipelineResults = await runtime.toolPipeline.executeBatch(toolCalls, signal);
          results = pipelineResults.map((result) => result as ToolResult);
        } else if (runtime.executeToolCalls !== undefined) {
          results = await runtime.executeToolCalls(toolCalls, signal);
        }
        for (const call of toolCalls) {
          await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
        }
        for (const result of results) {
          for (const update of result.updates ?? []) {
            await emit({
              type: "tool_execution_update",
              toolCallId: result.callId,
              toolName: result.tool ?? "",
              args: {},
              partialResult: update.partialResult,
            });
          }
          await emit({
            type: "tool_execution_end",
            toolCallId: result.callId,
            toolName: result.tool ?? "",
            result: result.message.content,
            isError: result.isError ?? false,
            ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          });
        }
      }

      runtime.onStep?.("appendToolResultsAndFinishTurn");
      const resultByCallId = new Map(results.map((result) => [result.callId, result]));
      const orderedResults = toolCalls
        .map((call) => resultByCallId.get(call.id))
        .filter((result): result is ToolResult => result !== undefined);
      const toolResultMessages = (orderedResults.length === results.length ? orderedResults : results).map(
        (result) => result.message
      );
      for (const message of toolResultMessages) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
      }
      const turn: LastTurn = { message: response.message, toolResults: toolResultMessages };
      const action = await resolveAction(runtime, turn, toolCalls.length, signal);
      await emit({ type: "turn_end", message: response.message, toolResults: toolResultMessages });
      lastTurn = turn;

      runtime.onStep?.("decisionEnd");
      const shouldEnd = action === "end";
      runtime.onStep?.("decisionContinue");
      const shouldContinue = action === "continue";
      runtime.onStep?.("outerFollowUpOrBreak");
      if (shouldEnd) {
        if (inbox.size("followUp") > 0) {
          pending = inbox.poll("followUp").map((item) => ({ id: item.id, body: item.body }));
          enterInner = true;
          continue;
        }
        await emitAgentEnd();
        return runtime.getState();
      }

      hasMoreToolCalls = shouldContinue && toolCalls.length > 0;
      if (inbox.size("nextTurn") > 0) enterInner = true;
      explicitContinuation = shouldContinue && toolCalls.length === 0 && inbox.size("nextTurn") === 0;
    }

    runtime.onStep?.("outerFollowUpOrBreak");
    const followUps = runtime.pollFollowUp !== undefined
      ? await runtime.pollFollowUp(signal)
      : inbox.poll("followUp").map((item) => item.body);
    if (followUps.length > 0) {
      pending = followUps.map((body) => ({ id: 0, body }));
      lastTurn = undefined;
      explicitContinuation = false;
      continue;
    }
    if (explicitContinuation) {
      pending = [];
      enterInner = true;
      explicitContinuation = false;
      continue;
    }
    break;
  }

  await emitAgentEnd();
  return runtime.getState();
}
