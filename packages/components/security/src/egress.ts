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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("INVALID_EGRESS_URL");
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

/** 最大跟随跳数：超过即失败关闭，不把无界重定向链交给底层 fetch。 */
export const MAX_EGRESS_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308]);
const BODYLESS_REDIRECT_STATUSES = new Set([301, 302, 303]);

/** 查询串中携带凭据的参数名；跨 origin 时一律移除，不接受大小写变体绕过。 */
export const CREDENTIAL_QUERY_PARAMS: readonly string[] = Object.freeze([
  "key",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "x-goog-api-key",
  "code",
  "sig",
  "signature",
  "credential",
]);

const CREDENTIAL_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|x-zeta-token|api-key|token|secret|credential)|(auth|secret|credential)$/i;

/** 跨 origin 时移除请求头中的凭证；保留与身份无关的普通头。 */
export function stripCredentialHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (CREDENTIAL_HEADER_PATTERN.test(name)) headers.delete(name);
  }
}

/** 跨 origin 时移除查询串中的绑定参数，保留非凭证参数。 */
export function stripCredentialQueryParams(url: URL): void {
  for (const name of [...url.searchParams.keys()]) {
    const normalized = name.toLowerCase();
    if (CREDENTIAL_QUERY_PARAMS.includes(normalized) || /^(x-.+-(key|token)|.*(secret|credential))$/i.test(normalized)) {
      url.searchParams.delete(name);
    }
  }
}

interface OutboundRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: RequestInit["body"];
  readonly signal: RequestInit["signal"];
  readonly rest: Omit<RequestInit, "body" | "headers" | "method" | "signal">;
}

/** 把 string/URL/Request 统一拆成可逐跳重建的请求部件，避免 Request 输入丢失 method/headers/body。 */
function readOutboundRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): OutboundRequest {
  const request = input instanceof Request ? input : undefined;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(request?.headers);
  if (init?.headers !== undefined) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  const rest = { ...init };
  delete rest.body;
  delete rest.headers;
  delete rest.method;
  delete rest.signal;
  return {
    url,
    method: init?.method ?? request?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? init.body : request?.body ?? undefined,
    signal: init?.signal !== undefined ? init.signal : request?.signal ?? undefined,
    rest,
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
  /** 唯一出站入口：每一跳都重新解析目标并过所有门禁，失败在底层 fetch 之前抛错。 */
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
  assert(url: string): void;
}

/**
 * 数据面单一门禁：返回的 gateway 不持有底层 fetch 引用，调用方无法从对象上取得逃生口；
 * 重定向改为手动跟随，30x 的每一跳都重新走 resolve → policy → enforcers → DNS。
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

  function checkHop(url: string): void {
    const target = resolveEgressTarget(url);
    assertEgressAllowed(policy, target);
    for (const enforcer of enforcers) enforcer.enforce(target);
  }

  return {
    policy,
    assert,
    async fetch(input, init) {
      const outbound = readOutboundRequest(input, init);
      let url = outbound.url;
      let method = outbound.method;
      let body = outbound.body;
      let origin = new URL(url).origin;

      for (let hop = 0; hop <= MAX_EGRESS_REDIRECTS; hop += 1) {
        checkHop(url);
        await dns.lookup(resolveEgressTarget(url).host);

        const hopInit: RequestInit & { duplex?: string } = {
          ...outbound.rest,
          method,
          headers: outbound.headers,
          // 阻断底层 fetch 的自动跟随：重定向必须由本门禁逐跳重验后再发起。
          redirect: "manual",
        };
        if (body !== undefined) {
          hopInit.body = body;
          if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) hopInit.duplex = "half";
        }
        if (outbound.signal !== undefined) hopInit.signal = outbound.signal;
        const response = await options.fetch(url, hopInit);
        const location = response.headers.get("location");
        if (!REDIRECT_STATUSES.has(response.status) || location === null || location.length === 0) return response;
        if (hop === MAX_EGRESS_REDIRECTS) throw new Error("EGRESS_REDIRECT_LIMIT");
        void response.body?.cancel();

        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new Error("EGRESS_REDIRECT_INVALID");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("EGRESS_REDIRECT_SCHEME");
        if (next.origin !== origin) {
          stripCredentialHeaders(outbound.headers);
          stripCredentialQueryParams(next);
        }
        if (BODYLESS_REDIRECT_STATUSES.has(response.status) && method !== "GET" && method !== "HEAD") {
          method = "GET";
          body = undefined;
          outbound.headers.delete("content-length");
          outbound.headers.delete("content-type");
        }
        url = next.toString();
        origin = next.origin;
      }
      throw new Error("EGRESS_REDIRECT_LIMIT");
    },
  };
}
