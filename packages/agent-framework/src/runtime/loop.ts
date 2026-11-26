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
import { shouldTerminateToolBatch } from "../tools/pipeline";
import type {
  LoopToolCall,
  LoopToolResult,
  ToolCompletionSink,
  ToolDeclarationDelta,
  ToolExecutionUpdate,
  ToolResult as UnifiedToolResult,
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

/** prepareNextTurn 的可替换字段；未给出的字段保留上一轮值。 */
export interface NextTurnUpdate {
  readonly context?: unknown;
  readonly messages?: readonly AgentMessage[];
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export function asNextTurnUpdate(value: unknown): NextTurnUpdate | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // manager.run 无 hook 时原样返回 AgentState：它也有 messages，但不是 turn 更新。
  if ("isStreaming" in record || "pendingToolCalls" in record || "systemPrompt" in record) return undefined;
  const update: NextTurnUpdate = {
    ...(record.context !== undefined ? { context: record.context } : {}),
    ...(Array.isArray(record.messages) ? { messages: record.messages as readonly AgentMessage[] } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.thinkingLevel === "string" ? { thinkingLevel: record.thinkingLevel } : {}),
  };
  return Object.keys(update).length > 0 ? update : undefined;
}

/** source 的重轮询时机：prepareNextTurn 之后、finishTurn 之后。 */
export type SourcePollPhase = "prepareNextTurn" | "finishTurn";

export interface LoopRuntime {
  readonly inbox: Inbox;
  readonly signal?: AbortSignal;
  emit(event: AgentEvent, signal?: AbortSignal): Promise<void> | void;
  getState(): AgentState;
  prepareNextTurn?(lastTurn: LastTurn | undefined, signal?: AbortSignal): NextTurnUpdate | unknown | void | Promise<NextTurnUpdate | unknown | void>;
  /** 重轮询 steering/followUp source；上层把消息写入 inbox，loop 不在这里消费队列。 */
  pollSources?(phase: SourcePollPhase, signal?: AbortSignal): void | Promise<void>;
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
  /** 单次 run 允许的 provider 回合上限；超出后不发下一轮请求。 */
  readonly turnBudget?: number;
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

/**
 * 三种终局：
 * - end：显式决策（finishTurn/decide/decision/waterfall）要求结束，硬终止且保留队列。
 * - continue：显式决策要求续跑；无工具时留下一次 context-only 请求（explicitContinuation）。
 * - natural：无显式决策且内层已无请求/工具，交还外层消费 follow-up。
 */
type TurnAction = "continue" | "end" | "natural";

async function resolveAction(
  runtime: LoopRuntime,
  turn: LastTurn,
  toolCallCount: number,
  signal?: AbortSignal
): Promise<TurnAction> {
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
  return toolCallCount > 0 ? "continue" : "natural";
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
  let turnCount = 0;
  // nextStep 只在 prepareNextTurn（已有 lastTurn）时 claim：首轮/硬终局不得吞掉未唤醒的注入消息。
  let pending: readonly InboxMessage[] = inbox.poll("nextTurn");
  let nextTurnRequest: { context?: unknown; model?: string; thinkingLevel?: string } = {};
  let injectedMessageId = -1;

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
        const update = asNextTurnUpdate(await runtime.prepareNextTurn?.(lastTurn, signal));
        if (update !== undefined) {
          const { messages, ...requestFields } = update;
          if (Object.keys(requestFields).length > 0) nextTurnRequest = { ...nextTurnRequest, ...requestFields };
          if (messages !== undefined) {
            pending = [...pending, ...messages.map((body) => ({ id: injectedMessageId--, body }))];
          }
        }
        await runtime.pollSources?.("prepareNextTurn", signal);
        pending = [...pending, ...inbox.poll("nextTurn"), ...inbox.poll("nextStep")];
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

      turnCount += 1;
      if (runtime.turnBudget !== undefined && turnCount > runtime.turnBudget) {
        await emitAgentEnd();
        return runtime.getState();
      }

      runtime.onStep?.("prepareRequest");
      const baseRequest = { ...nextTurnRequest, messages: runtime.getState().messages };
      const request = await runtime.prepareRequest?.(baseRequest, signal) ?? baseRequest;

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
          const callsById = new Map(toolCalls.map((call) => [call.id, call]));
          for (const call of toolCalls) {
            await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
          }
          // completion sink 在每个 finalize/cleanup 完成后立即发事件：end 顺序即完成顺序。
          const sink: ToolCompletionSink = async (result) => {
            const call = callsById.get(result.callId);
            const name = result.tool ?? call?.name ?? "";
            const args = result.args ?? call?.args ?? {};
            for (const update of result.updates ?? []) {
              await emit({
                type: "tool_execution_update",
                toolCallId: result.callId,
                toolName: name,
                args,
                partialResult: update.partialResult,
              });
            }
            await emit({
              type: "tool_execution_end",
              toolCallId: result.callId,
              toolName: name,
              args,
              result: result.message?.content ?? result.output,
              isError: result.isError ?? false,
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
            });
          };
          const pipelineResults = await runtime.toolPipeline.executeBatch(toolCalls, signal, sink);
          results = pipelineResults.map((result) => result as ToolResult);
        } else if (runtime.executeToolCalls !== undefined) {
          results = await runtime.executeToolCalls(toolCalls, signal);
        }
        // 兼容路径没有 completion sink：整批返回后按结果数组顺序补发事件。
        if (response.stopReason === "length" || runtime.toolPipeline === undefined) {
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
      }
      const terminating =
        results.length > 0 && shouldTerminateToolBatch(results as readonly UnifiedToolResult[]);

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
      // 全 terminate 与显式 end 同等硬终止；natural 只表示内层无更多请求/工具。
      const action: TurnAction = terminating ? "end" : await resolveAction(runtime, turn, toolCalls.length, signal);
      await emit({ type: "turn_end", message: response.message, toolResults: toolResultMessages });
      lastTurn = turn;
      // 只有显式 continue 才在 finishTurn 后重轮询 source；硬终局不污染队列，
      // natural end 也不需要重复注入 followUp（否则持续产出型 source 会无限续跑）。
      if (!terminating && action === "continue") await runtime.pollSources?.("finishTurn", signal);

      runtime.onStep?.("decisionEnd");
      const shouldEnd = terminating || action === "end";
      runtime.onStep?.("decisionContinue");
      const shouldContinue = action === "continue";
      runtime.onStep?.("outerFollowUpOrBreak");
      if (shouldEnd) {
        // decision end / all terminate：立即 agent_end 并返回，followUp/nextTurn/nextStep 一律原样保留。
        await emitAgentEnd();
        return runtime.getState();
      }

      hasMoreToolCalls = shouldContinue && toolCalls.length > 0;
      if (inbox.size("nextTurn") > 0 || inbox.size("nextStep") > 0) enterInner = true;
      explicitContinuation = shouldContinue && toolCalls.length === 0
        && inbox.size("nextTurn") === 0 && inbox.size("nextStep") === 0;
    }

    runtime.onStep?.("outerFollowUpOrBreak");
    const followUps = runtime.pollFollowUp !== undefined
      ? await runtime.pollFollowUp(signal)
      : inbox.poll("followUp").map((item) => item.body);
    if (followUps.length > 0) {
      pending = followUps.map((body) => ({ id: 0, body }));
      // follow-up 进入外层不代表新一轮从零开始：保留 lastTurn，下一轮仍走 prepareNextTurn。
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
