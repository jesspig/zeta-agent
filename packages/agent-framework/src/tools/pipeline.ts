import type { Disposer } from "@zeta-agent/framework";

export type PermissionBehavior = "ALLOW" | "DENY" | "ASK" | "PASSTHROUGH";

export const PERMISSION_BEHAVIORS = ["ALLOW", "DENY", "ASK", "PASSTHROUGH"] as const satisfies readonly PermissionBehavior[];

export interface PermissionVerdict {
  readonly behavior: PermissionBehavior;
  readonly reason?: string;
  readonly bypassImmune?: boolean;
}

export interface PermissionGuard {
  evaluate(
    verdicts: readonly PermissionVerdict[],
    options?: { readonly bypass?: boolean }
  ): PermissionVerdict;
}

const RANK: Readonly<Record<PermissionBehavior, number>> = {
  PASSTHROUGH: 0,
  ALLOW: 1,
  ASK: 2,
  DENY: 3,
};

export function createPermissionGuard(): PermissionGuard {
  return {
    evaluate(verdicts, options = {}) {
      let winner: PermissionVerdict = { behavior: "PASSTHROUGH" };
      for (const verdict of verdicts) {
        if (
          options.bypass === true &&
          verdict.bypassImmune !== true &&
          (verdict.behavior === "DENY" || verdict.behavior === "ASK")
        ) {
          continue;
        }
        if (RANK[verdict.behavior] > RANK[winner.behavior]) winner = verdict;
      }
      return winner;
    },
  };
}

export interface ToolUpdate {
  readonly callId: string;
  readonly tool: string;
  readonly phase: "update";
  readonly partialResult: unknown;
  readonly terminate: (reason?: string) => void;
}

export interface ToolExecuteContext {
  readonly onUpdate: (partialResult: unknown) => void;
  readonly terminate: (reason?: string) => void;
  readonly terminated: () => boolean;
  readonly signal?: AbortSignal;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly inputSchema: readonly string[];
  readonly outputSchema: readonly string[];
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    exec: ToolExecuteContext
  ) => unknown | Promise<unknown>;
}

export interface ToolRegistry {
  registerTool(tool: ToolDescriptor): Disposer;
  getTool(name: string): ToolDescriptor | undefined;
  readonly size: number;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDescriptor>();
  return {
    registerTool(tool) {
      if (tools.has(tool.name)) throw new Error("TOOL_DUPLICATE");
      tools.set(tool.name, tool);
      return () => {
        tools.delete(tool.name);
      };
    },
    getTool: (name) => tools.get(name),
    get size() {
      return tools.size;
    },
  };
}

export interface TerminationController {
  readonly signal: AbortSignal;
  readonly terminated: boolean;
  readonly reason?: string;
  terminate(reason?: string): void;
}

export function createTerminationController(): TerminationController {
  const abort = new AbortController();
  let terminated = false;
  let reason: string | undefined;
  return {
    get signal() {
      return abort.signal;
    },
    get terminated() {
      return terminated;
    },
    get reason() {
      return reason;
    },
    terminate(input?: string) {
      if (terminated) return;
      terminated = true;
      reason = input ?? "terminated";
      abort.abort(reason);
    },
  };
}

export interface ToolCall {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly output: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface BatchContext {
  readonly registry: ToolRegistry;
  readonly guard?: PermissionGuard;
  readonly verdicts?: readonly PermissionVerdict[];
  readonly bypass?: boolean;
  readonly clock?: () => number;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly controller?: TerminationController;
}

export function validateInput(tool: ToolDescriptor, input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("TOOL_INPUT_NOT_OBJECT");
  }
  const allowed = new Set(tool.inputSchema);
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new Error(`TOOL_INPUT_EXTRA_FIELD: ${key}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(call: ToolCall, reason: string, startedAt: number, endedAt: number): ToolResult {
  return {
    callId: call.id,
    tool: call.tool,
    output: { error: reason },
    isError: true,
    durationMs: Math.max(0, endedAt - startedAt),
    reason,
  };
}

export async function executeCall(call: ToolCall, ctx: BatchContext): Promise<ToolResult> {
  const clock = ctx.clock ?? (() => performance.now());
  const tool = ctx.registry.getTool(call.tool);
  if (tool === undefined) return errorResult(call, "TOOL_NOT_FOUND", clock(), clock());

  try {
    validateInput(tool, call.input);
  } catch (error) {
    return errorResult(call, errorMessage(error), clock(), clock());
  }

  const guard = ctx.guard ?? createPermissionGuard();
  const verdict = guard.evaluate(ctx.verdicts ?? [], { bypass: ctx.bypass ?? false });
  if (verdict.behavior === "DENY") {
    return errorResult(call, `TOOL_PERMISSION_DENIED: ${verdict.reason ?? "denied"}`, clock(), clock());
  }
  if (verdict.behavior === "ASK") {
    return errorResult(call, `TOOL_PERMISSION_ASK: ${verdict.reason ?? "confirmation required"}`, clock(), clock());
  }
  if (ctx.controller?.terminated === true) {
    return errorResult(call, "BATCH_TERMINATED", clock(), clock());
  }

  let settled = false;
  const pending: Promise<unknown>[] = [];
  const exec: ToolExecuteContext = {
    onUpdate(partialResult) {
      if (settled) return;
      const update: ToolUpdate = {
        callId: call.id,
        tool: call.tool,
        phase: "update",
        partialResult,
        terminate: (reason) => ctx.controller?.terminate(reason),
      };
      const returned = ctx.onUpdate?.(update);
      if (returned !== undefined && typeof (returned as PromiseLike<unknown>).then === "function") {
        pending.push(Promise.resolve(returned));
      }
    },
    terminate: (reason) => ctx.controller?.terminate(reason),
    terminated: () => ctx.controller?.terminated === true,
    signal: ctx.controller?.signal,
  };

  const startedAt = clock();
  let output: unknown;
  try {
    output = await tool.execute(call.input, exec);
  } catch (error) {
    settled = true;
    await Promise.allSettled(pending);
    return errorResult(call, `TOOL_EXECUTION_ERROR: ${errorMessage(error)}`, startedAt, clock());
  }
  settled = true;
  await Promise.allSettled(pending);
  const durationMs = Math.max(0, clock() - startedAt);

  if (output === undefined || output === null) {
    return errorResult(call, "TOOL_OUTPUT_MISSING", startedAt, startedAt + durationMs);
  }
  if (typeof output === "object") {
    const extra = Object.keys(output as Record<string, unknown>).find(
      (key) => !tool.outputSchema.includes(key)
    );
    if (extra !== undefined) {
      return errorResult(call, `TOOL_OUTPUT_EXTRA_FIELD: ${extra}`, startedAt, startedAt + durationMs);
    }
  }

  return {
    callId: call.id,
    tool: call.tool,
    output,
    isError: false,
    durationMs,
  };
}

export function executeBatch(
  batch: readonly ToolCall[],
  ctx: BatchContext
): Promise<readonly ToolResult[]> {
  return Promise.all(batch.map((call) => executeCall(call, ctx)));
}
