import { withCredentialFetch, type CredentialBoundaryRef } from "./credentials";
import {
  createDnsGate,
  createEgressGateway,
  createEgressPolicy,
  resolveEgressTarget,
  type DnsGate,
  type EgressEnforcer,
  type EgressGateway,
  type EgressPolicy,
  type EgressPolicyOptions,
  type EgressRule,
} from "./egress";

/** 从用户显式配置的端点推导唯一 allow 规则；端点缺失/非法直接抛错，不静默放行。 */
export function egressRuleFromUrl(url: string): EgressRule {
  const target = resolveEgressTarget(url);
  return { host: target.host, port: target.port };
}

export interface OutboundClientOptions {
  readonly egress: EgressPolicy | EgressPolicyOptions;
  readonly fetch: typeof fetch;
  readonly dns?: DnsGate;
  readonly enforcers?: readonly EgressEnforcer[];
  readonly credential?: CredentialBoundaryRef;
}

export interface OutboundClient {
  readonly policy: EgressPolicy;
  readonly gateway: EgressGateway;
  /** 所有 provider / discovery / image / MCP / remote 共用的唯一出站 fetch。 */
  fetch: typeof fetch;
}

function toPolicy(egress: EgressPolicy | EgressPolicyOptions): EgressPolicy {
  if ("defaultAction" in egress) return egress;
  return createEgressPolicy(egress);
}

/**
 * 统一出站客户端：把 egress 门禁、DNS gate、平台 enforcer 与凭证边界收敛到一个 fetch 入口。
 * 无 allow 规则不是「提示后继续」，而是在任何底层 fetch 之前抛配置错误（同时保留 EGRESS_DENIED 语义）。
 */
export function createOutboundClient(options: OutboundClientOptions): OutboundClient {
  if (typeof options.fetch !== "function") throw new Error("INVALID_OUTBOUND_FETCH");
  const policy = toPolicy(options.egress);
  const dns = options.dns ?? createDnsGate(policy);
  const gateway = createEgressGateway({
    policy,
    fetch: options.fetch,
    dns,
    ...(options.enforcers === undefined ? {} : { enforcers: options.enforcers }),
  });
  const credentialFetch = options.credential === undefined
    ? gateway.fetch
    : withCredentialFetch(options.credential.broker, options.credential.handle, gateway.fetch as typeof fetch);
  const gatedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (policy.allow.length === 0) {
      throw new Error("EGRESS_DENIED: EGRESS_ALLOW_REQUIRED 未配置任何 allow 规则，出站默认拒绝；请显式配置允许的目标");
    }
    return credentialFetch(input, init);
  }) as typeof fetch;
  return { policy, gateway, fetch: gatedFetch as typeof fetch };
}

export interface ResolveOutboundOptions {
  readonly outbound?: OutboundClient;
  readonly egress?: EgressPolicy | EgressPolicyOptions;
  /** 仅作为底层 transport；未显式提供 outbound 时由默认拒绝策略包装后才能使用。 */
  readonly fetch: typeof fetch;
}

/**
 * 所有出站消费者取得 fetch 的唯一方式：
 * - 显式 outbound 直接复用；
 * - 否则用注入的 fetch 作为底层 transport，套上显式策略（缺省空 allow → 失败关闭）。
 * 任何调用方都不可能绕过 OutboundClient.fetch 直接使用裸 transport。
 */
export function resolveOutboundFetch(options: ResolveOutboundOptions): typeof fetch {
  if (options.outbound !== undefined) return options.outbound.fetch;
  return createOutboundClient({
    egress: options.egress ?? createEgressPolicy(),
    fetch: options.fetch,
  }).fetch;
}
