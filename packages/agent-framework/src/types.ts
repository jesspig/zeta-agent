import type { CoeffectKey, Disposer, Effect } from "@zeta-agent/framework";
import type { AgentEvent } from "./runtime/agent";

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
  readonly execute: (input: P) => unknown | Promise<unknown>;
}

export interface EventBus {
  on(name: string, listener: (event: AgentEvent) => void): Disposer;
  emit(name: string, event: AgentEvent): void;
}

export type Converter = (input: unknown) => AgentEvent | undefined;
export type ContextTransform = (context: unknown) => unknown;
export type BeforeHook = (event: AgentEvent) => void | Promise<void>;
export type AfterHook = (event: AgentEvent) => void | Promise<void>;
export type FinishTurn = (event: AgentEvent) => void | Promise<void>;
export type PrepareRequest = (request: unknown) => unknown;
export type PrepareNextTurn = (context: unknown) => unknown;

export interface QueueSource {
  readonly name: string;
  readonly next: () => unknown;
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
