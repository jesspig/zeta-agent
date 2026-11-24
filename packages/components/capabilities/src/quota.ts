export interface QuotaCheck {
  readonly tool?: string;
  readonly tokens?: number;
}

export interface QuotaReserve {
  readonly tool?: string;
  readonly tokens: number;
}

export interface QuotaConfig {
  /** 该 realm 的 token 预算；必须是正整数。 */
  readonly tokens: number;
  /** 按工具名覆盖单次消耗；缺省 1。 */
  readonly toolCosts?: Readonly<Record<string, number>>;
}

export interface QuotaService {
  readonly capacity: number;
  check(request: string | QuotaCheck): boolean;
  reserve(request: number | QuotaReserve): boolean;
  remaining(): number;
  /** 仅用于发射失败等已 reserve 但未派发的场景；归还量受容量上限约束。 */
  release(tokens: number): void;
}

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
 * 因而不会出现"check 通过但 reserve 超额"的竞态。
 */
export function createQuotaService(config: QuotaConfig): QuotaService {
  if (!isPositiveInteger(config.tokens)) throw new Error("QUOTA_INVALID_CAPACITY");
  const toolCosts = config.toolCosts ?? {};
  let used = 0;

  const costOf = (request: QuotaCheck | QuotaReserve): number => {
    if (request.tokens !== undefined) return request.tokens;
    const tool = request.tool;
    if (tool === undefined || tool.length === 0) return 0;
    return toolCosts[tool] ?? 1;
  };

  return {
    capacity: config.tokens,
    check(request) {
      const check = normalizeCheck(request);
      if (check.tool === "" || (check.tool === undefined && check.tokens === undefined)) return false;
      const cost = costOf(check);
      return isPositiveInteger(cost) && used + cost <= config.tokens;
    },
    reserve(request) {
      const reserve = normalizeReserve(request);
      const cost = reserve.tokens;
      if (!isPositiveInteger(cost) || used + cost > config.tokens) return false;
      used += cost;
      return true;
    },
    remaining() {
      return config.tokens - used;
    },
    release(tokens) {
      if (!isPositiveInteger(tokens)) return;
      used = Math.max(0, used - tokens);
    },
  };
}
