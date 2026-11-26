// observability adapter 的稳定 facade 入口：effect 观测桥与日志/导出适配器。
export {
  createEffectBridge,
  createLogger,
  createOtlpHttpExporter,
  createOtlpSpanExporter,
  createSpanCollector,
  getActiveEffectBridge,
  redact,
  resolveLogSink,
  setActiveEffectBridge,
  spansFromEffectMeta,
} from "@zeta-agent/observability";
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
  OtlpSpan,
  OtlpWireOptions,
  RedactRule,
  SinkOptions,
  SinkResolution,
  Span,
  SpanExporter,
} from "@zeta-agent/observability";
export type { EffectMeta, EffectObserver } from "@zeta-agent/cordis/types";
