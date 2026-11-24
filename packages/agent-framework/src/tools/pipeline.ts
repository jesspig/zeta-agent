import type { Disposer } from "@zeta-agent/framework";
import type { AgentMessage } from "../runtime/agent";
import {
  createToolResultMessage,
  normalizeToolArgs,
  shouldTerminateToolBatch,
  toolInput,
  toolName,
  type JsonSchemaObject,
  type JsonSchemaProperty,
  type PipelineToolCall,
  type PipelineToolResult,
  type ToolBudgets,
  type ToolCall as UnifiedToolCall,
  type ToolCleanupContext,
  type ToolCompletionSink,
  type ToolInputSchema,
  type ToolResult as UnifiedToolResult,
  type ToolDeclarationDelta,
  type ToolExecutionConfig,
  type ToolExecutionMode,
  type ToolRetryPolicy,
} from "./types";

export type { ToolExecutionMode, ToolExecutionConfig, ToolDeclarationDelta } from "./types";
export { shouldTerminateToolBatch, createToolResultMessage } from "./types";

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
  readonly inputSchema: ToolInputSchema;
  /** 省略时不做输出字段约束（应用层工具的返回值形状由自身契约负责）。 */
  readonly outputSchema?: readonly string[];
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    exec: ToolExecuteContext
  ) => unknown | Promise<unknown>;
  /** 兼容 shim：在校验前把原始参数投影为工具期望的形状。 */
  readonly prepareArguments?: (args: unknown) => unknown | Promise<unknown>;
  readonly executionMode?: ToolExecutionMode;
  readonly timeoutMs?: number;
  readonly retry?: ToolRetryPolicy;
  /** 返回 promise 即视为 acknowledgement；ack 之前不发布事件。 */
  readonly cleanup?: (context: ToolCleanupContext) => void | Promise<void>;
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

/** 旧流水线调用形状别名：tool/input 必填。 */
export type ToolCall = PipelineToolCall;

/** 旧流水线结果形状别名：工具字段与计时必填。 */
export type ToolResult = PipelineToolResult;

export interface BeforeToolCallInput {
  readonly call: ToolCall;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface BeforeToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly terminate?: boolean;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type BeforeToolCallHook = (
  input: BeforeToolCallInput,
  signal?: AbortSignal
) => BeforeToolCallResult | void | Promise<BeforeToolCallResult | void>;

export interface AfterToolCallInput {
  readonly call: ToolCall;
  readonly output: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface AfterToolCallResult {
  readonly content?: unknown;
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly usage?: unknown;
  readonly terminate?: boolean;
}

export type AfterToolCallHook = (
  input: AfterToolCallInput,
  signal?: AbortSignal
) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;

/** T-02 插件管理器满足该结构，工具流水线不直接依赖具体实现。 */
export interface ToolHookRunner {
  run<I>(
    chain: string,
    input: I,
    signal?: AbortSignal,
    options?: { readonly failClosed?: boolean }
  ): Promise<I>;
}

export interface ToolPublisher {
  (result: ToolResult): ToolResult | Promise<ToolResult>;
}

export interface BatchContext {
  readonly registry: ToolRegistry;
  readonly guard?: PermissionGuard;
  readonly verdicts?: readonly PermissionVerdict[];
  readonly bypass?: boolean;
  readonly clock?: () => number;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly controller?: TerminationController;
  /** 全局执行策略；缺省沿用现状（并行）。 */
  readonly toolExecution?: ToolExecutionConfig;
  readonly manager?: ToolHookRunner;
  readonly beforeToolCall?: BeforeToolCallHook | readonly BeforeToolCallHook[];
  readonly afterToolCall?: AfterToolCallHook | readonly AfterToolCallHook[];
  readonly signal?: AbortSignal;
  /** finalize（含 cleanup）完成后按完成顺序调用；loop 据此实时发 end 事件。 */
  readonly completionSink?: ToolCompletionSink;
  /** 发布前的最后变换点（facade 在此提交 durable effects 并回填真实结果）。 */
  readonly publisher?: ToolPublisher;
  /** 每次调用的缺省超时；工具自身的 timeoutMs 优先。 */
  readonly timeoutMs?: number;
  readonly budgets?: ToolBudgets;
}

function valueMatchesSchema(value: unknown, property: JsonSchemaProperty): boolean {
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value) &&
        (property.items === undefined || value.every((item) => valueMatchesSchema(item, property.items!)));
    default:
      return false;
  }
}

export function validateInput(tool: ToolDescriptor, input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("TOOL_INPUT_NOT_OBJECT");
  }
  const record = input as Record<string, unknown>;
  const schema = tool.inputSchema;
  if (Array.isArray(schema)) {
    const allowed = new Set(schema);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new Error(`TOOL_INPUT_EXTRA_FIELD: ${key}`);
    }
    return;
  }
  const objectSchema = schema as JsonSchemaObject;
  const properties = objectSchema.properties ?? {};
  const allowExtra = objectSchema.additionalProperties !== false;
  for (const key of Object.keys(record)) {
    const property = properties[key];
    if (property === undefined) {
      if (!allowExtra) throw new Error(`TOOL_INPUT_EXTRA_FIELD: ${key}`);
      continue;
    }
    if (!valueMatchesSchema(record[key], property)) throw new Error(`TOOL_INPUT_TYPE: ${key}`);
  }
  for (const key of objectSchema.required ?? []) {
    if (!(key in record)) throw new Error(`TOOL_INPUT_REQUIRED: ${key}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(call: ToolCall, reason: string, startedAt: number, endedAt: number): ToolResult {
  // 字符串输出让 String(content) 仍能读到原因，兼容旧调用方的文本断言。
  const output = reason;
  return {
    callId: call.id,
    tool: toolName(call),
    args: toolInput(call),
    output,
    isError: true,
    durationMs: Math.max(0, endedAt - startedAt),
    reason,
    message: {
      role: "toolResult",
      content: output,
      toolCallId: call.id,
      toolName: toolName(call),
    },
  };
}

interface MutableBefore {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
  args?: Readonly<Record<string, unknown>>;
}

interface MutableAfter {
  content?: unknown;
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  usage?: unknown;
  terminate?: boolean;
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

function pickBefore(value: unknown): MutableBefore {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const result: MutableBefore = {};
  if (typeof record.block === "boolean") result.block = record.block;
  if (typeof record.reason === "string") result.reason = record.reason;
  if (typeof record.terminate === "boolean") result.terminate = record.terminate;
  if (typeof record.args === "object" && record.args !== null) result.args = normalizeToolArgs(record.args);
  return result;
}

function pickAfter(value: unknown): MutableAfter {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const result: MutableAfter = {};
  for (const key of ["content", "details", "structuredContent", "usage"] as const) {
    if (key in record) result[key] = record[key];
  }
  if (typeof record.isError === "boolean") result.isError = record.isError;
  if (typeof record.terminate === "boolean") result.terminate = record.terminate;
  return result;
}

async function runBeforeHooks(
  input: BeforeToolCallInput,
  ctx: BatchContext,
  signal?: AbortSignal
): Promise<MutableBefore> {
  let merged: MutableBefore = {};
  if (ctx.manager !== undefined) {
    const eventLike = {
      ...input,
      type: "tool_execution_start",
      toolCallId: input.call.id,
      toolName: input.tool,
    };
    const value = await ctx.manager.run<unknown>("beforeToolCall", eventLike, signal, { failClosed: true });
    merged = { ...merged, ...pickBefore(value) };
  }
  for (const hook of toArray(ctx.beforeToolCall)) {
    const value = await hook({ ...input, args: merged.args ?? input.args }, signal);
    merged = { ...merged, ...pickBefore(value) };
  }
  return merged;
}

async function runAfterHooks(
  input: AfterToolCallInput,
  ctx: BatchContext,
  signal?: AbortSignal
): Promise<MutableAfter> {
  let merged: MutableAfter = {};
  if (ctx.manager !== undefined) {
    const eventLike = {
      ...input,
      type: "tool_execution_end",
      toolCallId: input.call.id,
      toolName: toolName(input.call),
      result: input.output,
      isError: input.isError,
    };
    const value = await ctx.manager.run<unknown>("afterToolCall", eventLike, signal, { failClosed: true });
    merged = { ...merged, ...pickAfter(value) };
  }
  for (const hook of toArray(ctx.afterToolCall)) {
    const value = await hook(input, signal);
    merged = { ...merged, ...pickAfter(value) };
  }
  return merged;
}

export interface PreparedToolCall {
  readonly kind: "prepared";
  readonly call: ToolCall;
  readonly tool: ToolDescriptor;
  readonly args: Readonly<Record<string, unknown>>;
  readonly terminate: boolean;
}

export function isPreparedToolCall(value: PreparedToolCall | ToolResult): value is PreparedToolCall {
  return (value as PreparedToolCall).kind === "prepared";
}

export interface ExecutedToolCall {
  readonly kind: "executed";
  readonly prepared: PreparedToolCall;
  readonly output: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
  readonly reason?: string;
  readonly terminate: boolean;
  readonly structuredContent?: unknown;
  readonly updates: readonly { readonly partialResult: unknown }[];
}

function asPipelineCall(call: UnifiedToolCall): PipelineToolCall {
  return {
    ...call,
    tool: call.tool ?? call.name ?? "",
    input: normalizeToolArgs(toolInput(call)),
  };
}

/** prepare 阶段：查工具 → prepareArguments → 校验 → 权限 → beforeToolCall → 异常归一化。 */
export async function prepareToolCall(
  call: UnifiedToolCall,
  ctx: BatchContext
): Promise<PreparedToolCall | ToolResult> {
  const normalized = asPipelineCall(call);
  const clock = ctx.clock ?? (() => performance.now());
  const tool = ctx.registry.getTool(toolName(normalized));
  if (tool === undefined) return errorResult(normalized, "TOOL_NOT_FOUND", clock(), clock());

  try {
    let raw: unknown = toolInput(normalized);
    if (tool.prepareArguments !== undefined) raw = await tool.prepareArguments(raw);
    const preparedArgs = normalizeToolArgs(raw);
    validateInput(tool, preparedArgs);

    const guard = ctx.guard ?? createPermissionGuard();
    const verdict = guard.evaluate(ctx.verdicts ?? [], { bypass: ctx.bypass ?? false });
    if (verdict.behavior === "DENY") {
      return errorResult(normalized, `TOOL_PERMISSION_DENIED: ${verdict.reason ?? "denied"}`, clock(), clock());
    }
    if (verdict.behavior === "ASK") {
      return errorResult(normalized, `TOOL_PERMISSION_ASK: ${verdict.reason ?? "confirmation required"}`, clock(), clock());
    }

    const before = await runBeforeHooks({ call: normalized, tool: tool.name, args: preparedArgs }, ctx, ctx.signal);
    if (before.block === true) {
      const reason = `TOOL_BLOCKED_BY_HOOK: ${before.reason ?? "blocked"}`;
      return { ...errorResult(normalized, reason, clock(), clock()), terminate: before.terminate === true };
    }
    // hook 改写参数后必须重新校验，否则 before 阶段能注入未声明字段。
    const args = before.args ?? preparedArgs;
    validateInput(tool, args);
    return {
      kind: "prepared",
      call: normalized,
      tool,
      args,
      terminate: before.terminate === true,
    };
  } catch (error) {
    return errorResult(normalized, `TOOL_PREPARE_ERROR: ${errorMessage(error)}`, clock(), clock());
  }
}

/** execute 阶段：计时只包 execute()；retry/timeout 归一化为错误结果；onUpdate 迟到丢弃。 */
export async function executePreparedToolCall(
  prepared: PreparedToolCall,
  ctx: BatchContext
): Promise<ExecutedToolCall> {
  const clock = ctx.clock ?? (() => performance.now());
  const call = prepared.call;
  let settled = false;
  let terminateRequested = false;
  const pending: Promise<unknown>[] = [];
  const updates: Array<{ readonly partialResult: unknown }> = [];
  const exec: ToolExecuteContext = {
    onUpdate(partialResult) {
      if (settled) return;
      updates.push({ partialResult });
      const update: ToolUpdate = {
        callId: call.id,
        tool: toolName(call),
        phase: "update",
        partialResult,
        terminate: () => {
          terminateRequested = true;
        },
      };
      const returned = ctx.onUpdate?.(update);
      if (returned !== undefined && typeof (returned as PromiseLike<unknown>).then === "function") {
        pending.push(Promise.resolve(returned));
      }
    },
    terminate: () => {
      // 仅记录本调用意图；整批全 terminate 才由 shouldTerminateToolBatch 停止。
      terminateRequested = true;
    },
    terminated: () => ctx.controller?.terminated === true,
    signal: ctx.controller?.signal ?? ctx.signal,
  };

  const startedAt = clock();
  let output: unknown;
  let endedAt = startedAt;
  let executionError: unknown;
  const timeoutMs = prepared.tool.timeoutMs ?? ctx.timeoutMs;
  const maxAttempts = Math.max(1, prepared.tool.retry?.maxAttempts ?? 1);
  const retryDelay = Math.max(0, prepared.tool.retry?.delayMs ?? 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let attemptSettled = false;
    try {
      const returned = prepared.tool.execute(prepared.args, exec);
      if (
        returned !== null &&
        typeof returned === "object" &&
        typeof (returned as PromiseLike<unknown>).then === "function"
      ) {
        output = await new Promise<unknown>((resolve, reject) => {
          const timer =
            timeoutMs === undefined ? undefined : setTimeout(() => reject(new Error("TOOL_TIMEOUT")), timeoutMs);
          Promise.resolve(returned).then(
            (value) => {
              if (timer !== undefined) clearTimeout(timer);
              endedAt = clock();
              attemptSettled = true;
              resolve(value);
            },
            (error) => {
              if (timer !== undefined) clearTimeout(timer);
              endedAt = clock();
              attemptSettled = true;
              reject(error);
            }
          );
        });
      } else {
        // 同步返回时立刻停表，后续 onUpdate 的 promise 等待不计入 durationMs。
        endedAt = clock();
        attemptSettled = true;
        output = returned;
      }
      executionError = undefined;
      break;
    } catch (error) {
      executionError = error;
      if (!attemptSettled) endedAt = clock();
      if (attempt < maxAttempts && retryDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  settled = true;
  await Promise.allSettled(pending);
  const durationMs = Math.max(0, endedAt - startedAt);
  const terminate = prepared.terminate || terminateRequested;
  const failure = (reason: string): ExecutedToolCall => ({
    kind: "executed",
    prepared,
    output: { error: reason },
    durationMs,
    isError: true,
    reason,
    terminate,
    updates,
  });

  if (executionError !== undefined) {
    return failure(`TOOL_EXECUTION_ERROR: ${errorMessage(executionError)}`);
  }
  if (output === undefined || output === null) return failure("TOOL_OUTPUT_MISSING");

  const maxOutputChars = ctx.budgets?.maxOutputChars;
  if (maxOutputChars !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(output);
    } catch {
      serialized = String(output);
    }
    if (serialized.length > maxOutputChars) return failure("TOOL_OUTPUT_BUDGET_EXCEEDED");
  }
  const outputSchema = prepared.tool.outputSchema;
  if (outputSchema !== undefined && typeof output === "object" && output !== null) {
    const extra = Object.keys(output as Record<string, unknown>).find((key) => !outputSchema.includes(key));
    if (extra !== undefined) return failure(`TOOL_OUTPUT_EXTRA_FIELD: ${extra}`);
  }

  const failedOutput =
    typeof output === "object" && output !== null && (output as { ok?: unknown }).ok === false;
  const structuredContent =
    typeof output === "object" && output !== null
      ? (output as Record<string, unknown>).structuredContent
      : undefined;
  return {
    kind: "executed",
    prepared,
    output,
    durationMs,
    isError: failedOutput,
    ...(failedOutput ? { reason: "TOOL_OUTPUT_ERROR" } : {}),
    terminate,
    structuredContent,
    updates,
  };
}

/** finalize 阶段：afterToolCall 按字段覆盖 → structuredContent 规则 → toolResult 消息。 */
export async function finalizeExecutedToolCall(
  executed: ExecutedToolCall,
  ctx: BatchContext
): Promise<ToolResult> {
  const input: AfterToolCallInput = {
    call: executed.prepared.call,
    output: executed.output,
    isError: executed.isError,
    durationMs: executed.durationMs,
    reason: executed.reason,
  };
  let after: MutableAfter = {};
  try {
    after = await runAfterHooks(input, ctx, ctx.signal);
  } catch (error) {
    const reason = `TOOL_FINALIZE_ERROR: ${errorMessage(error)}`;
    return createToolResultMessage(executed.prepared.call, {
      ...errorResult(executed.prepared.call, reason, 0, executed.durationMs),
      terminate: executed.terminate,
      updates: executed.updates,
    }) as ToolResult;
  }

  const output = after.content !== undefined ? after.content : executed.output;
  const structuredContent =
    after.structuredContent !== undefined
      ? after.structuredContent
      : after.content !== undefined
        ? undefined
        : executed.structuredContent;
  const result: ToolResult = {
    callId: executed.prepared.call.id,
    tool: toolName(executed.prepared.call),
    args: toolInput(executed.prepared.call),
    output,
    isError: after.isError ?? executed.isError,
    durationMs: executed.durationMs,
    reason: executed.reason,
    terminate: after.terminate ?? executed.terminate,
    structuredContent,
    details: after.details,
    usage: after.usage,
    updates: executed.updates,
  };
  const cleanup = executed.prepared.tool.cleanup;
  if (cleanup !== undefined) {
    try {
      await cleanup({ callId: result.callId, tool: result.tool ?? "", output });
    } catch (error) {
      const reason = `TOOL_CLEANUP_FAILED: ${errorMessage(error)}`;
      return createToolResultMessage(executed.prepared.call, {
        ...errorResult(executed.prepared.call, reason, 0, executed.durationMs),
        terminate: executed.terminate,
        updates: executed.updates,
      }) as ToolResult;
    }
  }
  return createToolResultMessage(executed.prepared.call, result) as ToolResult;
}

/** 发布：先经过 publisher（facade 的 durable commit 回填），再按完成顺序通知 sink。 */
export async function publishResult(result: ToolResult, ctx: BatchContext): Promise<ToolResult> {
  try {
    const published = ctx.publisher === undefined ? result : await ctx.publisher(result);
    if (ctx.completionSink !== undefined) await ctx.completionSink(published);
    return published;
  } catch (error) {
    const reason = `TOOL_PUBLISH_ERROR: ${errorMessage(error)}`;
    return { ...result, isError: true, reason, output: { error: reason } };
  }
}

/** 三段管线的串行编排，供 executeBatch 与嵌套调用复用。 */
export async function executeCall(call: UnifiedToolCall, ctx: BatchContext): Promise<ToolResult> {
  const prepared = await prepareToolCall(call, ctx);
  if (!isPreparedToolCall(prepared)) return prepared;
  return finalizeExecutedToolCall(await executePreparedToolCall(prepared, ctx), ctx);
}

export function resolveToolExecutionMode(batch: readonly UnifiedToolCall[], ctx: BatchContext): ToolExecutionMode {
  const configured = ctx.toolExecution;
  const global = typeof configured === "string" ? configured : configured?.mode;
  if (global === "sequential" || global === "parallel") return global;
  for (const call of batch) {
    if (call.executionMode === "sequential") return "sequential";
    if (ctx.registry.getTool(toolName(call))?.executionMode === "sequential") return "sequential";
  }
  return "parallel";
}

function budgetBlocked(call: UnifiedToolCall): ToolResult {
  return errorResult(asPipelineCall(call), "TOOL_CALL_BUDGET_EXCEEDED", 0, 0);
}

/** 兼容导出：默认并行；preflight 串行，执行并行，完成即发布，结果按源码顺序落盘。 */
export async function executeBatch(
  batch: readonly UnifiedToolCall[],
  ctx: BatchContext
): Promise<readonly ToolResult[]> {
  if (resolveToolExecutionMode(batch, ctx) === "sequential") {
    const results: ToolResult[] = [];
    for (const [index, call] of batch.entries()) {
      const overBudget = ctx.budgets?.maxToolCalls !== undefined && index >= ctx.budgets.maxToolCalls;
      const result = overBudget ? budgetBlocked(call) : await executeCall(call, ctx);
      results.push(await publishResult(result, ctx));
    }
    return results;
  }

  const prepared: Array<PreparedToolCall | ToolResult> = [];
  for (const [index, call] of batch.entries()) {
    if (ctx.budgets?.maxToolCalls !== undefined && index >= ctx.budgets.maxToolCalls) {
      prepared.push(budgetBlocked(call));
    } else {
      prepared.push(await prepareToolCall(call, ctx));
    }
  }
  return Promise.all(
    prepared.map(async (item) => {
      const result = isPreparedToolCall(item)
        ? await finalizeExecutedToolCall(await executePreparedToolCall(item, ctx), ctx)
        : item;
      return publishResult(result, ctx);
    })
  );
}

/** 公开嵌套调用入口：复用同一流水线，但不发事件、不加消息。 */
export async function runToolCall(call: UnifiedToolCall, ctx: BatchContext): Promise<ToolResult> {
  const result = await executeCall(call, ctx);
  const { message: _message, ...withoutMessage } = result;
  void _message;
  return withoutMessage;
}

function declarationName(value: string | { readonly name: string }): string {
  return typeof value === "string" ? value : value.name;
}

/** 工具声明 delta：以 system 消息承载工具清单变更，保持 system 消息为单一事实源。 */
export function declareToolChanges(
  previous: readonly (string | { readonly name: string })[],
  next: readonly (string | { readonly name: string })[],
  systemPrompt = ""
): ToolDeclarationDelta {
  const before = new Set(previous.map(declarationName));
  const after = new Set(next.map(declarationName));
  const toolsAdded = [...after].filter((name) => !before.has(name));
  const toolsRemoved = [...before].filter((name) => !after.has(name));
  const names = [...after].sort();
  const lines = [systemPrompt, `tools: ${names.join(", ")}`].filter((line) => line.length > 0);
  const message: AgentMessage = { role: "system", content: lines.join("\n") };
  const messages = toolsAdded.length > 0 || toolsRemoved.length > 0 || systemPrompt.length > 0 ? [message] : [];
  return { toolsAdded, toolsRemoved, messages };
}

export interface ToolPipeline {
  readonly context: BatchContext;
  prepareToolCall(call: UnifiedToolCall): Promise<PreparedToolCall | ToolResult>;
  executePreparedToolCall(prepared: PreparedToolCall): Promise<ExecutedToolCall>;
  finalizeExecutedToolCall(executed: ExecutedToolCall): Promise<ToolResult>;
  executeCall(call: UnifiedToolCall): Promise<ToolResult>;
  executeBatch(
    batch: readonly UnifiedToolCall[],
    signal?: AbortSignal,
    completionSink?: ToolCompletionSink
  ): Promise<readonly ToolResult[]>;
  runToolCall(call: UnifiedToolCall): Promise<ToolResult>;
  declareToolChanges(previous: readonly string[], next: readonly string[], systemPrompt?: string): ToolDeclarationDelta;
  shouldTerminate(results: readonly UnifiedToolResult[]): boolean;
}

/** 绑定上下文的管线句柄，供 loop 与嵌套调用共享同一实现。 */
export function createToolPipeline(ctx: BatchContext): ToolPipeline {
  return {
    context: ctx,
    prepareToolCall: (call) => prepareToolCall(call, ctx),
    executePreparedToolCall: (prepared) => executePreparedToolCall(prepared, ctx),
    finalizeExecutedToolCall: (executed) => finalizeExecutedToolCall(executed, ctx),
    executeCall: (call) => executeCall(call, ctx),
    executeBatch: (batch, signal, completionSink) =>
      executeBatch(batch, {
        ...ctx,
        ...(signal === undefined ? {} : { signal }),
        ...(completionSink === undefined ? {} : { completionSink }),
      }),
    runToolCall: (call) => runToolCall(call, ctx),
    declareToolChanges,
    shouldTerminate: shouldTerminateToolBatch,
  };
}
