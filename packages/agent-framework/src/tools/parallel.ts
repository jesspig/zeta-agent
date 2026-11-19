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

  while (remaining.size > 0) {
    const level: ConditionalCall[] = [];
    for (const call of remaining.values()) {
      if ((call.dependsOn ?? []).every((dep) => !remaining.has(dep))) level.push(call);
    }
    if (level.length === 0) level.push(...remaining.values());
    for (const call of level) remaining.delete(call.id);

    await Promise.allSettled(
      level.map(async (call) => {
        if (ctx.controller?.terminated === true) {
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

  return batch.map((call) => results.get(call.id) as ToolResult);
}
