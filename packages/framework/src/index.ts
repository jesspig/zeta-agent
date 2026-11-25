// 只重导出稳定契约：core types、context/fiber、objects、loader、typed events 与 observability adapter。
export * from "./types";
export * from "./objects";
export * from "./loader";

export {
  CONTEXT_DISPOSED,
  contribute,
  createContext,
  createView,
  defineComponent,
  defineKey,
  defineRegistry,
  notify,
  on,
  resolveRegistry,
  use,
  VERSION_MISMATCH,
} from "./context";
export type {
  ComponentSpec,
  Context,
  ContextFiber,
  KeyOptions,
  Registry,
  RegistryOptions,
} from "./context";

export { createEventBus, type EventBusOptions } from "./events";
export type {
  DispatchOptions,
  EventBus,
  EventName,
  Events,
  Listener,
  WaterfallListener,
} from "./events";

export {
  createEffectBridge,
  createLogger,
  getActiveEffectBridge,
  redact,
  resolveLogSink,
  setActiveEffectBridge,
  spansFromEffectMeta,
} from "./observability";
export type {
  EffectBridge,
  FileSink,
  FiberLogger,
  LogLevel,
  LogMessage,
  Logger,
  LoggerOptions,
  LogSink,
  OtlpExporter,
  RedactRule,
  SinkOptions,
  SinkResolution,
  Span,
} from "./observability";
