import { renderHudPanel, type ContextBudget } from "./hud";

/** 最近秩分位数：p=0.99 返回不小于 99% 样本的最小观测值。 */
export function percentile(values: readonly number[], p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("p: expected a number in [0, 1]");
  for (const value of values) if (!Number.isFinite(value)) throw new Error("values: expected finite numbers");
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length)) - 1;
  return sorted[Math.min(sorted.length - 1, rank)]!;
}

export interface RuntimeMetrics {
  readonly eventLoopLagP99Ms: number;
  readonly frameP99Ms: number;
  readonly cpuMs: number;
  readonly rssBytes: number;
  readonly samples: number;
}

export interface MetricsObservation {
  readonly eventLoopLagMs?: number;
  readonly frameMs?: number;
  readonly cpuMs?: number;
  readonly rssBytes?: number;
}

export interface MetricsSampler {
  readonly capacity: number;
  sample(observation?: MetricsObservation): void;
  snapshot(): RuntimeMetrics;
}

export interface MetricsSamplerOptions {
  /** 环形缓冲容量；有界，避免长会话采样本身成为内存增长源。 */
  readonly capacity?: number;
  readonly cpuMs?: () => number;
  readonly rssBytes?: () => number;
  readonly eventLoopLagMs?: () => number;
}

export function createMetricsSampler(options: MetricsSamplerOptions = {}): MetricsSampler {
  const capacity = options.capacity ?? 120;
  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("capacity: expected a positive integer");
  const lags: number[] = [];
  const frames: number[] = [];
  let cpuMs = 0;
  let rssBytes = 0;
  const push = (buffer: number[], value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value)) throw new Error("observation: expected finite numbers");
    buffer.push(value);
    if (buffer.length > capacity) buffer.shift();
  };
  const readCpu = options.cpuMs ?? (() => process.cpuUsage().user / 1000);
  const readRss = options.rssBytes ?? (() => process.memoryUsage().rss);
  return {
    capacity,
    sample(observation = {}) {
      push(lags, observation.eventLoopLagMs ?? options.eventLoopLagMs?.());
      push(frames, observation.frameMs);
      const nextCpu = observation.cpuMs ?? readCpu();
      if (nextCpu !== undefined) cpuMs = nextCpu;
      const nextRss = observation.rssBytes ?? readRss();
      if (nextRss !== undefined) rssBytes = nextRss;
    },
    snapshot() {
      return {
        eventLoopLagP99Ms: percentile(lags, 0.99),
        frameP99Ms: percentile(frames, 0.99),
        cpuMs,
        rssBytes,
        samples: Math.max(lags.length, frames.length),
      };
    },
  };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/** 在既有 context budget 面板后追加运行时指标行，供 Debug HUD 复用。 */
export function renderDebugHud(budget: ContextBudget, metrics: RuntimeMetrics): string {
  return [
    renderHudPanel(budget),
    `EVENT p99=${metrics.eventLoopLagP99Ms}ms FRAME p99=${metrics.frameP99Ms}ms`,
    `CPU ${metrics.cpuMs}ms RSS ${megabytes(metrics.rssBytes)} N=${metrics.samples}`,
  ].join("\n");
}
