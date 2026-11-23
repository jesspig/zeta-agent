import {
  executePreparedToolCall,
  finalizeExecutedToolCall,
  isPreparedToolCall,
  prepareToolCall,
  resolveToolExecutionMode,
  shouldTerminateToolBatch,
  type BatchContext,
  type PreparedToolCall,
  type ToolResult,
} from "./pipeline";
import type { PipelineToolCall } from "./types";

export interface ConditionalCall extends PipelineToolCall {
  readonly dependsOn?: readonly string[];
}

export type ParallelContext = BatchContext;

function blockedResult(call: ConditionalCall, reason: string): ToolResult {
  const output = { error: reason };
  return {
    callId: call.id,
    tool: call.tool,
    output,
    isError: true,
    durationMs: 0,
    reason,
    message: {
      role: "toolResult",
      content: output,
      toolCallId: call.id,
      toolName: call.tool,
    },
  };
}

type PreparedLevelItem =
  | { readonly kind: "blocked"; readonly result: ToolResult }
  | { readonly kind: "prepared"; readonly outcome: PreparedToolCall | ToolResult };

export async function executeConditionalBatch(
  batch: readonly ConditionalCall[],
  ctx: ParallelContext
): Promise<readonly ToolResult[]> {
  const results = new Map<string, ToolResult>();
  const remaining = new Map(batch.map((call) => [call.id, call]));
  // 批次开始时若已被上一批终止，整批阻塞；批次内部不因单个 terminate 阻塞同批。
  const blockedFromPriorBatch = ctx.controller?.terminated === true;
  const sequential = resolveToolExecutionMode(batch, ctx) === "sequential";

  while (remaining.size > 0) {
    const level: ConditionalCall[] = [];
    for (const call of remaining.values()) {
      if ((call.dependsOn ?? []).every((dep) => !remaining.has(dep))) level.push(call);
    }
    if (level.length === 0) level.push(...remaining.values());
    for (const call of level) remaining.delete(call.id);

    // preflight 串行：按源码顺序完成查工具/校验/hooks，再统一执行。
    const preflighted: PreparedLevelItem[] = [];
    for (const call of level) {
      if (blockedFromPriorBatch) {
        preflighted.push({ kind: "blocked", result: blockedResult(call, "BATCH_TERMINATED") });
        continue;
      }
      const unmet = (call.dependsOn ?? []).some(
        (dep) => !results.has(dep) || results.get(dep)?.isError === true
      );
      if (unmet) {
        preflighted.push({ kind: "blocked", result: blockedResult(call, "TOOL_DEPENDENCY_UNSATISFIED") });
        continue;
      }
      preflighted.push({ kind: "prepared", outcome: await prepareToolCall(call, ctx) });
    }

    const runItem = async (item: PreparedLevelItem): Promise<ToolResult> => {
      if (item.kind === "blocked") return item.result;
      if (!isPreparedToolCall(item.outcome)) return item.outcome;
      return finalizeExecutedToolCall(await executePreparedToolCall(item.outcome, ctx), ctx);
    };
    const settled: readonly PromiseSettledResult<ToolResult>[] = sequential
      ? await (async () => {
          const outcomes: PromiseSettledResult<ToolResult>[] = [];
          for (const item of preflighted) {
            try {
              outcomes.push({ status: "fulfilled", value: await runItem(item) });
            } catch (error) {
              outcomes.push({ status: "rejected", reason: error });
            }
          }
          return outcomes;
        })()
      : await Promise.allSettled(preflighted.map(runItem));
    // 每个输入槽位都要有结果：拒绝（如 guard/clock 抛错）转成对应调用的失败结果。
    settled.forEach((outcome, index) => {
      const call = level[index]!;
      results.set(
        call.id,
        outcome.status === "fulfilled"
          ? outcome.value
          : blockedResult(call, `TOOL_BATCH_REJECTED: ${String(outcome.reason)}`),
      );
    });
  }

  const finalized = batch.map((call) => results.get(call.id) as ToolResult);
  // 不变量 #10：仅当整批每个 finalized result 都 terminate===true 才真正停止。
  // 混合批次保持未终止，后续批次可继续执行。
  if (ctx.controller !== undefined && shouldTerminateToolBatch(finalized)) {
    ctx.controller.terminate("all-terminated");
    return finalized.map((result, index) => ({
      ...blockedResult(batch[index] as ConditionalCall, "BATCH_TERMINATED"),
      terminate: true,
      durationMs: result.durationMs,
    }));
  }
  return finalized;
}
