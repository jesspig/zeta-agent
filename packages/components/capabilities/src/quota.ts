import type { CoeffectKey } from "@zeta-agent/cordis/types";

export interface QuotaCheck {
  readonly tool?: string;
  readonly tokens?: number;
  /** 本次调用的 qps 需求；缺省按 1 次计。 */
  readonly qps?: number;
}

export interface QuotaReserve {
  readonly tool?: string;
  readonly tokens: number;
  /** 本次调用的 qps 需求；缺省按 1 次计。 */
  readonly qps?: number;
}

export interface QuotaConfig {
  /** 该 realm 的 token 预算；必须是正整数。 */
  readonly tokens: number;
  /** 按工具名覆盖单次消耗；缺省 1。 */
  readonly toolCosts?: Readonly<Record<string, number>>;
  /** 该 realm 的每秒调用上限；缺省不限制。必须是正整数。 */
  readonly qps?: number;
  /** 注入时钟，便于确定性验证滑动秒窗；缺省 Date.now。 */
  readonly clock?: () => number;
}

export interface QuotaService {
  readonly capacity: number;
  readonly qps?: number;
  check(request: string | QuotaCheck): boolean;
  reserve(request: number | QuotaReserve): boolean;
  remaining(): number;
  /** 当前秒窗内剩余 qps；未配置 qps 时返回 undefined。 */
  qpsRemaining(): number | undefined;
  /** 仅用于发射失败等已 reserve 但未派发的场景；归还量受容量上限约束。 */
  release(tokens: number): void;
}

/**
 * 配额 coeffect key：每个 realm 的 root context 通过 provide 注入自己的
 * QuotaService 实例，消费者按 realm 解析，不共享预算。
 * 组件包只依赖 cordis 类型，不反向依赖 framework。
 */
export const quotaKey: CoeffectKey<QuotaService> = Object.freeze({
  namespace: "@zeta-agent/capabilities",
  name: "quota",
  symbol: Symbol("@zeta-agent/capabilities:quota"),
});

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeReserve(request: number | QuotaReserve): QuotaReserve {
  return typeof request === "number" ? { tokens: request } : request;
}

function normalizeCheck(request: string | QuotaCheck): QuotaCheck {
  return typeof request === "string" ? { tool: request } : request;
}

/**
 * 同步原子扣减：reserve 内不 await，多个并发调用在单线程上串行完成，
 * 因而不会出现"check 通过但 reserve 超额"的竞态。qps 用滑动秒窗计数，
 * 时钟可注入；check 只读不计数，reserve 成功后才累计命中。
 */
export function createQuotaService(config: QuotaConfig): QuotaService {
  if (!isPositiveInteger(config.tokens)) throw new Error("QUOTA_INVALID_CAPACITY");
  if (config.qps !== undefined && !isPositiveInteger(config.qps)) throw new Error("QUOTA_INVALID_QPS");
  const toolCosts = config.toolCosts ?? {};
  const qpsLimit = config.qps;
  const clock = config.clock ?? Date.now;
  let used = 0;
  let window = Math.floor(clock() / 1000);
  let windowHits = 0;

  const rollWindow = (): void => {
    const now = Math.floor(clock() / 1000);
    if (now !== window) {
      window = now;
      windowHits = 0;
    }
  };

  const qpsAllows = (request: QuotaCheck | QuotaReserve): boolean => {
    if (qpsLimit === undefined) return true;
    rollWindow();
    const demand = request.qps ?? 1;
    return isPositiveInteger(demand) && windowHits + demand <= qpsLimit;
  };

  const costOf = (request: QuotaCheck | QuotaReserve): number => {
    if (request.tokens !== undefined) return request.tokens;
    const tool = request.tool;
    if (tool === undefined || tool.length === 0) return 0;
    return toolCosts[tool] ?? 1;
  };

  return {
    capacity: config.tokens,
    ...(qpsLimit === undefined ? {} : { qps: qpsLimit }),
    check(request) {
      const check = normalizeCheck(request);
      if (check.tool === "" || (check.tool === undefined && check.tokens === undefined)) return false;
      const cost = costOf(check);
      return isPositiveInteger(cost) && used + cost <= config.tokens && qpsAllows(check);
    },
    reserve(request) {
      const reserve = normalizeReserve(request);
      const cost = reserve.tokens;
      if (!isPositiveInteger(cost) || used + cost > config.tokens || !qpsAllows(reserve)) return false;
      used += cost;
      if (qpsLimit !== undefined) windowHits += reserve.qps ?? 1;
      return true;
    },
    remaining() {
      return config.tokens - used;
    },
    qpsRemaining() {
      if (qpsLimit === undefined) return undefined;
      rollWindow();
      return qpsLimit - windowHits;
    },
    release(tokens) {
      if (!isPositiveInteger(tokens)) return;
      used = Math.max(0, used - tokens);
    },
  };
}
