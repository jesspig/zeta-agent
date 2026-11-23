import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@zeta-agent/agent";
import type { FooterMetrics } from "./components/footer";
import type { AgentUsageTelemetry, TokenUsage, UsagePricing } from "./telemetry-types";

export const DEFAULT_CONTEXT_LIMIT = 128000;

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** 从 .git/HEAD 读取当前分支（无子进程），失败时返回 undefined。 */
export function detectGitBranch(pwd: string | undefined): string | undefined {
  if (!pwd) return undefined;
  try {
    const head = readFileSync(join(pwd, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function numberAt(record: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** 从 provider 的 usage 载荷中提取 token 计数；兼容 snake/camel 两种字段命名。 */
export function extractTokenUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const nested = record.usage;
  const source =
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? (nested as Readonly<Record<string, unknown>>)
      : record;
  const inputTokens = numberAt(source, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens", "input"]);
  const outputTokens = numberAt(source, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens", "output"]);
  const cacheReadTokens = numberAt(source, [
    "cache_read_tokens",
    "cache_read_input_tokens",
    "cache_read",
    "cacheReadTokens",
    "cacheRead",
  ]);
  const cacheWriteTokens = numberAt(source, [
    "cache_write_tokens",
    "cache_creation_input_tokens",
    "cache_write",
    "cacheWriteTokens",
    "cacheWrite",
  ]);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** 按每百万 token 价格计算累计成本；无定价时返回 0（如实报告，不估算）。 */
export function computeCostUsd(usage: TokenUsage, pricing: UsagePricing | undefined): number {
  if (pricing === undefined) return 0;
  const rate = (tokens: number, perMillion: number | undefined): number =>
    (tokens * (perMillion ?? 0)) / 1_000_000;
  return (
    rate(usage.inputTokens, pricing.inputPerMillion) +
    rate(usage.outputTokens, pricing.outputPerMillion) +
    rate(usage.cacheReadTokens, pricing.cacheReadPerMillion) +
    rate(usage.cacheWriteTokens, pricing.cacheWritePerMillion)
  );
}

export function usageMetrics(usage: TokenUsage, pricing?: UsagePricing): FooterMetrics {
  const cacheTotal = usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheHitPercent: cacheTotal === 0 ? 0 : Math.round((usage.cacheReadTokens / cacheTotal) * 100),
    costUsd: computeCostUsd(usage, pricing),
  };
}

/** 上下文窗口只计输入侧 token（输入 + 缓存读写），输出 token 不重复占用。 */
export function usedContextTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export interface UsageSnapshot {
  readonly metrics: FooterMetrics;
  readonly usedTokens: number;
}

export interface UsageTracker {
  consume(event: AgentEvent): void;
  snapshot(): UsageSnapshot;
}

/**
 * 从真实 agent 事件累计 token 用量。只在 message_end 记账（该事件携带最终 usage），
 * 避免把流式 message_update 的中间快照重复累加。
 */
export function createUsageTracker(
  options: { readonly pricing?: UsagePricing; readonly initialUsage?: Partial<TokenUsage> } = {},
): UsageTracker {
  let usage: TokenUsage = { ...ZERO_USAGE, ...options.initialUsage };
  return {
    consume(event) {
      if (event.type !== "message_end") return;
      const sample = extractTokenUsage(event.message);
      if (sample !== null) usage = addUsage(usage, sample);
    },
    snapshot() {
      return {
        metrics: usageMetrics(usage, options.pricing),
        usedTokens: usedContextTokens(usage),
      };
    },
  };
}

/** 给运行时构造初始遥测：分支默认从 cwd 探测，session/pricing 由宿主提供。 */
export function initialTelemetry(options: AgentUsageTelemetry): AgentUsageTelemetry {
  return {
    ...options,
    branch: options.branch ?? detectGitBranch(options.cwd ?? options.pwd),
  };
}
