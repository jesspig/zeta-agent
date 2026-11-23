import type { FooterMetrics } from "./components/footer";

/** 一次运行累计的真实 token 用量（不掺入消息数估算）。 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** 模型定价（每百万 token），由宿主按当前模型的目录元数据注入。 */
export interface UsagePricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
}

/** 进入 FooterBridge 的真实遥测快照：token/成本/分支/会话均由宿主或事件源提供。 */
export interface AgentUsageTelemetry {
  /** 工作目录：用于探测 git 分支与折叠显示。 */
  readonly cwd?: string;
  readonly pwd?: string;
  readonly home?: string;
  readonly branch?: string;
  readonly session?: string;
  readonly metrics?: FooterMetrics;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinking?: boolean;
  /** 上下文占用 token；缺省时由 metrics 的输入侧 token 推导。 */
  readonly usedTokens?: number;
  readonly contextLimit?: number;
  /** 无事件源时的真实起始用量（如恢复会话）。 */
  readonly initialUsage?: Partial<TokenUsage>;
  readonly pricing?: UsagePricing;
}
