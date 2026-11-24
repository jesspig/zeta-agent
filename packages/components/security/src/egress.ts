export interface EgressRule {
  readonly host: string;
  readonly port?: number;
}

export interface EgressTarget {
  readonly host: string;
  readonly port: number;
}

export interface EgressPolicy {
  readonly defaultAction: "deny";
  readonly allow: readonly EgressRule[];
  readonly denyAlways: readonly EgressRule[];
}

export interface EgressPolicyOptions {
  readonly allow?: readonly EgressRule[];
  readonly denyAlways?: readonly EgressRule[];
}

export function createEgressPolicy(options: EgressPolicyOptions = {}): EgressPolicy {
  return {
    defaultAction: "deny",
    allow: options.allow ?? [],
    denyAlways: options.denyAlways ?? [],
  };
}

function matches(rule: EgressRule, target: EgressTarget): boolean {
  return rule.host === target.host && (rule.port === undefined || rule.port === target.port);
}

export function isEgressAllowed(policy: EgressPolicy, target: EgressTarget): boolean {
  if (policy.denyAlways.some((rule) => matches(rule, target))) return false;
  return policy.allow.some((rule) => matches(rule, target));
}

export function assertEgressAllowed(policy: EgressPolicy, target: EgressTarget): void {
  if (!isEgressAllowed(policy, target)) throw new Error("EGRESS_DENIED");
}

/** URL → 目标（含协议默认端口）；所有网络调用必须先归一化成这个结构再过门禁。 */
export function resolveEgressTarget(url: string): EgressTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INVALID_EGRESS_URL");
  }
  const port = parsed.port !== ""
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : parsed.protocol === "http:"
        ? 80
        : Number.NaN;
  if (!Number.isInteger(port) || port <= 0) throw new Error("INVALID_EGRESS_URL");
  return { host: parsed.hostname, port };
}

export type DnsResolver = (host: string) => string | Promise<string>;

export interface DnsGate {
  readonly policy: EgressPolicy;
  /** 未放行的主机在调用 resolver 之前就被拒绝（DNS 默认拒绝）。 */
  lookup(host: string): Promise<string>;
}

/** sidecar / nftables 等平台强制层：只接受已通过策略的目标，任一层抛错即整条链路失败。 */
export interface EgressEnforcer {
  readonly name: string;
  enforce(target: EgressTarget): void;
}

export function createDnsGate(policy: EgressPolicy, resolver: DnsResolver = (host) => host): DnsGate {
  return {
    policy,
    async lookup(host: string): Promise<string> {
      // DNS 层只按主机名判定：平台 deny 优先，未被 allow 覆盖的主机一律不解析。
      if (policy.denyAlways.some((rule) => rule.host === host)) throw new Error("DNS_DENIED");
      if (!policy.allow.some((rule) => rule.host === host)) throw new Error("DNS_DENIED");
      return resolver(host);
    },
  };
}

export interface EgressGatewayOptions {
  readonly policy: EgressPolicy;
  readonly fetch: typeof fetch;
  readonly dns?: DnsGate;
  readonly enforcers?: readonly EgressEnforcer[];
}

export interface EgressGateway {
  readonly policy: EgressPolicy;
  /** 唯一出站入口：每次请求都重新解析目标并过所有门禁，失败在底层 fetch 之前抛错。 */
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
  assert(url: string): void;
}

/**
 * 数据面单一门禁：返回的 gateway 不持有底层 fetch 引用，调用方无法从对象上取得逃生口。
 * DNS 解析默认走 createDnsGate，因此没有显式 allow 规则时连解析都不会发生。
 */
export function createEgressGateway(options: EgressGatewayOptions): EgressGateway {
  if (typeof options.fetch !== "function") throw new Error("INVALID_EGRESS_FETCH");
  const policy = options.policy;
  const dns = options.dns ?? createDnsGate(policy);
  const enforcers = options.enforcers ?? [];

  function assert(url: string): void {
    const target = resolveEgressTarget(url);
    assertEgressAllowed(policy, target);
    for (const enforcer of enforcers) enforcer.enforce(target);
  }

  return {
    policy,
    assert,
    async fetch(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const target = resolveEgressTarget(url);
      assertEgressAllowed(policy, target);
      for (const enforcer of enforcers) enforcer.enforce(target);
      await dns.lookup(target.host);
      return options.fetch(input, init);
    },
  };
}
