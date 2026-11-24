import type { CoeffectKey, Disposer, Effect } from "@zeta-agent/framework";
import type { AgentEvent } from "./runtime/agent";
import type { ToolExecutionMode } from "./tools/types";

export type LayerState = "active" | "degraded" | "unsupported" | "disabled";

export interface Capabilities {
  isolation: LayerState;
  seccomp: LayerState;
  fsConfinement: LayerState;
  auditSink: LayerState;
  egressDefaultDeny: LayerState;
}

export interface EffectMeta {
  label: string;
  children: EffectMeta[];
}

export interface RedactRule {
  readonly match: RegExp | string;
  readonly replace: string;
}

export interface AgentTool<P = unknown> {
  readonly name: string;
  readonly execute: (input: P, signal?: AbortSignal) => unknown | Promise<unknown>;
  /** 工具声明的执行偏好；统一流水线据此决定整批串行或并行。 */
  readonly executionMode?: ToolExecutionMode;
}

export interface EventBus {
  on(name: string, listener: (event: AgentEvent) => void): Disposer;
  emit(name: string, event: AgentEvent): void;
}

export type Converter = (input: unknown) => AgentEvent | undefined;
export type ContextTransform = (context: unknown) => unknown;
export type BeforeHook = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
/** after 钩子可返回字段覆盖：facade 会把 content/structuredContent/details 等投影到流水线结果。 */
export type AfterHookResult = {
  readonly content?: unknown;
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly usage?: unknown;
  readonly terminate?: boolean;
};
export type AfterHook = (
  event: AgentEvent,
  signal?: AbortSignal
) => AfterHookResult | void | Promise<AfterHookResult | void>;
export type FinishTurn = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
export type PrepareRequest = (request: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
export type PrepareNextTurn = (context: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;

export interface QueueSource {
  readonly name: string;
  readonly next: () => unknown | Promise<unknown>;
}

export type StreamFn = (input: unknown) => AsyncIterable<unknown>;

export interface CoreContextLike {
  get<T>(key: CoeffectKey<T>): T;
  effect(callback: (ctx: CoreContextLike) => Effect, label?: string): Disposer;
}

export interface AgentPluginApi {
  registerTool(tool: AgentTool<never>): () => void;
  onEvent(handler: (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>): () => void;
  addConverter(fn: Converter): () => void;
  addContextTransform(fn: ContextTransform): () => void;
  addBeforeToolCall(fn: BeforeHook): () => void;
  addAfterToolCall(fn: AfterHook): () => void;
  addTurnBoundary(fn: FinishTurn): () => void;
  addPrepareRequest(fn: PrepareRequest): () => void;
  addPrepareNextTurn(fn: PrepareNextTurn): () => void;
  provideSteering(source: QueueSource): () => void;
  provideFollowUp(source: QueueSource): () => void;
  provideStreamFn(fn: StreamFn): () => void;
  declareToolLoadout(tools: AgentTool<never>[]): void;
  useContext(): CoreContextLike | undefined;
  readonly events: EventBus;
  capabilities(): Capabilities;
  onEffect(handler: (meta: EffectMeta) => void): () => void;
  addRedactor(rule: RedactRule): () => void;
}
