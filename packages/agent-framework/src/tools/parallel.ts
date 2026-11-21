import { executeCall, type BatchContext, type ToolCall, type ToolResult } from "./pipeline";

export interface ConditionalCall extends ToolCall {
  readonly dependsOn?: readonly string[];
}

export type ParallelContext = BatchContext;

function blockedResult(call: ConditionalCall, reason: string): ToolResult {
  return {
    callId: call.id,
    tool: call.tool,
    output: { error: reason },
    isError: true,
    durationMs: 0,
    reason,
  };
}

export async function executeConditionalBatch(
  batch: readonly ConditionalCall[],
  ctx: ParallelContext
): Promise<readonly ToolResult[]> {
  const results = new Map<string, ToolResult>();
  const remaining = new Map(batch.map((call) => [call.id, call]));
  // 批次开始时若已被上一批终止，整批阻塞；批次内部不因单个 terminate 阻塞同批。
  const blockedFromPriorBatch = ctx.controller?.terminated === true;

  while (remaining.size > 0) {
    const level: ConditionalCall[] = [];
    for (const call of remaining.values()) {
      if ((call.dependsOn ?? []).every((dep) => !remaining.has(dep))) level.push(call);
    }
    if (level.length === 0) level.push(...remaining.values());
    for (const call of level) remaining.delete(call.id);

    await Promise.allSettled(
      level.map(async (call) => {
        if (blockedFromPriorBatch) {
          results.set(call.id, blockedResult(call, "BATCH_TERMINATED"));
          return;
        }
        const unmet = (call.dependsOn ?? []).some(
          (dep) => !results.has(dep) || results.get(dep)?.isError === true
        );
        if (unmet) {
          results.set(call.id, blockedResult(call, "TOOL_DEPENDENCY_UNSATISFIED"));
          return;
        }
        results.set(call.id, await executeCall(call, ctx));
      })
    );
  }

  const finalized = batch.map((call) => results.get(call.id) as ToolResult);
  // 不变量 #10：仅当整批每个 finalized result 都 terminate===true 才真正停止。
  // 混合批次保持未终止，后续批次可继续执行。
  if (
    ctx.controller !== undefined &&
    finalized.length > 0 &&
    finalized.every((result) => result.terminate === true)
  ) {
    ctx.controller.terminate("all-terminated");
    return finalized.map((result, index) => ({
      ...blockedResult(batch[index] as ConditionalCall, "BATCH_TERMINATED"),
      terminate: true,
      durationMs: result.durationMs,
    }));
  }
  return finalized;
}
