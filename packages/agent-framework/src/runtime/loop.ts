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
}

/** 旧 loop 结果形状别名：统一定义见 tools/types。 */
export type ToolResult = LoopToolResult;

export interface LastTurn {
  readonly message: AgentMessage;
  readonly toolResults: readonly AgentMessage[];
}

export interface LoopRuntime {
  readonly inbox: Inbox;
  emit(event: AgentEvent): Promise<void> | void;
  getState(): AgentState;
  prepareNextTurn?(lastTurn: LastTurn | undefined): void;
  /** 工具声明 delta：返回 system 消息或 delta 对象，由 loop 统一 emit。 */
  declareToolChanges?(): readonly AgentMessage[] | ToolDeclarationDelta | void;
  prepareRequest?(request: unknown): unknown;
  streamAssistant(request: unknown, onPartial?: (message: AgentMessage) => void | Promise<void>): Promise<AssistantResult>;
  executeToolCalls?(calls: readonly ToolCall[]): Promise<readonly ToolResult[]>;
  /** 提供时由统一 prepare/execute/finalize 管线执行工具，否则沿用 executeToolCalls。 */
  toolPipeline?: ToolPipeline;
  finishTurn?(turn: LastTurn): LoopDecision | undefined;
  decide?(state: AgentState, turn: LastTurn): LoopDecision;
  decision?(state: AgentState, turn: LastTurn): AgentDecision;
  waterfall?: DecisionWaterfall;
  pollFollowUp?(): readonly AgentMessage[];
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
    let decided: AgentDecision = initial;
    if (runtime.waterfall) {
      try {
        decided = await runtime.waterfall.run(initial, { state, event });
      } catch {
        // 归一化：hook 抛错不致命，回退到依据当前状态计算的安全决策。
        decided = nextAction(state);
      }
    }
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
    runtime.onStep?.("emitAgentEnd");
    await emit({ type: "agent_end", messages: runtime.getState().messages });
  }

  // pi 基线：首轮 turn_start 与初始 steering 轮询发生在 runLoop 之前
  // （runAgentLoop 前置 emit + 进入循环前的 getSteeringMessages）；
  // step1（prepareNextTurn → 再轮询 steering → turn_start）只在存在
  // lastCompletedTurn 的后续轮次进入，避免首轮误触发与重复 turn_start。
  // 首轮保留一次 prepareNextTurn?.(undefined) 兼容调用：A6 #4 既有断言要求
  // 每个 prompt 至少触发一次 hook；该调用不属于 step1（不记录 onStep、不轮询、不发 turn_start）。
  runtime.prepareNextTurn?.(undefined);
  await emit({ type: "turn_start" });
  let steering: readonly InboxMessage[] = inbox.poll("nextTurn");

  while (true) {
    if (lastTurn !== undefined) {
      runtime.onStep?.("prepareNextTurn");
      runtime.prepareNextTurn?.(lastTurn);
      steering = inbox.poll("nextTurn");
      await emit({ type: "turn_start" });
    }

    runtime.onStep?.("declareToolChanges");
    const declared = runtime.declareToolChanges?.();
    if (declared !== undefined) {
      const deltaMessages = "messages" in declared ? declared.messages : declared;
      for (const message of deltaMessages) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
      }
    }

    for (const item of steering) {
      await emit({ type: "message_start", message: item.body });
      await emit({ type: "message_end", message: item.body });
    }

    runtime.onStep?.("prepareRequest");
    const request = runtime.prepareRequest?.({ messages: runtime.getState().messages }) ?? {
      messages: runtime.getState().messages,
    };

    runtime.onStep?.("streamAssistant");
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

    runtime.onStep?.("hardExitCheck");
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const turn: LastTurn = { message: response.message, toolResults: [] };
      runtime.finishTurn?.(turn);
      await emit({ type: "turn_end", message: response.message, toolResults: [] });
      await emitAgentEnd();
      return runtime.getState();
    }

    runtime.onStep?.("executeToolCalls");
    const toolCalls = response.toolCalls;
    let results: readonly ToolResult[] = [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
      }
      if (response.stopReason === "length") {
        results = toolCalls.map((call) => ({
          callId: call.id,
          message: { role: "toolResult" as const, content: "truncated" },
          isError: true,
        }));
      } else if (runtime.toolPipeline !== undefined) {
        const pipelineResults = await runtime.toolPipeline.executeBatch(toolCalls);
        results = pipelineResults.map((result) => result as ToolResult);
      } else if (runtime.executeToolCalls !== undefined) {
        results = await runtime.executeToolCalls(toolCalls);
      } else {
        results = [];
      }
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

    // 完成通知按 results（完成顺序）发出；会话提交按 assistant 声明顺序排列，
    // 两者解耦，保证 transcript 顺序稳定且与工具声明对应。
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
    const action = await resolveAction(runtime, turn, toolCalls.length);
    await emit({ type: "turn_end", message: response.message, toolResults: toolResultMessages });
    lastTurn = turn;

    // 决策阶段进入序列按设计顺序记录（test-only），与 RUN_LOOP_STEPS 对齐。
    runtime.onStep?.("decisionEnd");
    const shouldEnd = action === "end";
    runtime.onStep?.("decisionContinue");
    const shouldContinue = action === "continue";
    runtime.onStep?.("outerFollowUpOrBreak");
    if (shouldEnd) {
      await emitAgentEnd();
      return runtime.getState();
    }

    // 只读判定队列是否非空：消息留到下一轮轮首统一 poll，避免被此处提前消费。
    explicitContinuation = toolCalls.length === 0 && inbox.size("nextTurn") === 0;

    // 决策为 continue（例如模型请求了原生工具调用）时必须进入下一轮，
    // 让工具结果回到模型；否则会在一轮后静默结束。
    if (shouldContinue) continue;

    const followUps = runtime.pollFollowUp?.() ?? inbox.poll("nextTurn");
    if (followUps.length > 0) continue;
    if (explicitContinuation) continue;
    break;
  }

  await emitAgentEnd();
  return runtime.getState();
}
