import type { AgentMessage } from "../runtime/agent";

/** 工具批处理执行方式：默认并行，任一调用或全局配置要求串行时整批串行。 */
export type ToolExecutionMode = "sequential" | "parallel";

/** 全局 toolExecution 既接受简写字符串，也接受带 mode 的配置对象。 */
export type ToolExecutionConfig = ToolExecutionMode | { readonly mode?: ToolExecutionMode };

/** 统一调用形状：tools 侧使用 tool/input，loop 侧使用 name/args，两者共用一份定义。 */
export interface ToolCall {
  readonly id: string;
  readonly tool?: string;
  readonly name?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly args?: unknown;
  readonly executionMode?: ToolExecutionMode;
  readonly dependsOn?: readonly string[];
}

/** 工具流水线侧旧形状（tool/input 必填）；保留旧名以兼容既有消费者。 */
export type PipelineToolCall = ToolCall & {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
};

/** loop 侧旧形状（name/args 必填）；保留旧名以兼容既有消费者。 */
export type LoopToolCall = ToolCall & { readonly name: string; readonly args: unknown };

/** 旧类型别名：等价于统一调用形状。 */
export type LegacyToolCall = ToolCall;

export interface ToolExecutionUpdate {
  readonly partialResult: unknown;
}

/** 完整 JSON Schema 的最小对象形状；旧的字符串 allowlist 仍被接受。 */
export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly items?: JsonSchemaProperty;
}

export interface JsonSchemaObject {
  readonly type?: "object";
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type ToolInputSchema = readonly string[] | JsonSchemaObject;

export interface ToolRetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs?: number;
}

export interface ToolBudgets {
  readonly maxOutputChars?: number;
  readonly maxToolCalls?: number;
  readonly maxTurns?: number;
}

/** finalize 完成后、发布最终结果之前调用；返回的 promise 即 cleanup acknowledgement。 */
export interface ToolCleanupContext {
  readonly callId: string;
  readonly tool: string;
  readonly output: unknown;
}

export type ToolCompletionSink = (result: ToolResult) => void | Promise<void>;

/** 统一结果形状：流水线字段与 loop 消息字段共存，旧消费者各取所需。 */
export interface ToolResult {
  readonly callId: string;
  readonly tool?: string;
  /** start/update/end 事件共用；finalize 把调用参数原样带回。 */
  readonly args?: unknown;
  readonly output?: unknown;
  readonly message?: AgentMessage;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly terminate?: boolean;
  readonly updates?: readonly ToolExecutionUpdate[];
  readonly structuredContent?: unknown;
  readonly details?: unknown;
  readonly usage?: unknown;
}

/** 工具流水线侧旧结果形状；保留旧名以兼容既有消费者。 */
export type PipelineToolResult = ToolResult & {
  readonly tool: string;
  readonly output: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
};

/** loop 侧旧结果形状；保留旧名以兼容既有消费者。 */
export type LoopToolResult = ToolResult & { readonly message: AgentMessage };

/** 旧类型别名：等价于统一结果形状。 */
export type LegacyToolResult = ToolResult;

export interface ToolDeclarationDelta {
  readonly toolsAdded: readonly string[];
  readonly toolsRemoved: readonly string[];
  readonly messages: readonly AgentMessage[];
}

export function toolName(call: ToolCall): string {
  return call.tool ?? call.name ?? "";
}

export function toolInput(call: ToolCall): unknown {
  return call.input ?? call.args ?? {};
}

/** 把 loop 侧的未知参数归一化为工具可消费的只读记录。 */
export function normalizeToolArgs(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      // 非法 JSON 交由工具实现拒绝，归一化为无参调用。
    }
  }
  return {};
}

/** finalize 阶段把流水线结果投影为 loop 可提交的 toolResult 消息。 */
export function createToolResultMessage(call: ToolCall, result: ToolResult): ToolResult {
  if (result.message !== undefined) return result;
  return {
    ...result,
    message: {
      role: "toolResult",
      content: result.output ?? result.reason ?? "",
      toolCallId: call.id,
      toolName: toolName(call),
    },
  };
}

/** 不变量 #10：整批所有 finalized 结果都请求终止才真正停止。 */
export function shouldTerminateToolBatch(results: readonly ToolResult[]): boolean {
  return results.length > 0 && results.every((result) => result.terminate === true);
}
