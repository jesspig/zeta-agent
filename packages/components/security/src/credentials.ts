/**
 * 统一凭证边界（IF-11）：明文只由 broker 在闭包内持有；facade 侧只拿到 handle/token。
 * 每次 resolve 都重新校验 origin / path segment / method / revision / TTL / revocation，
 * 失败直接抛错，不返回空值或默认头。
 */

export type CredentialScheme = "http" | "https";

export interface CredentialBinding {
  readonly scheme: CredentialScheme;
  readonly host: string;
  readonly port?: number;
  /** 精确分段前缀：["v1"] 命中 /v1 与 /v1/chat，不命中 /v10。 */
  readonly pathSegments?: readonly string[];
  readonly methods?: readonly string[];
}

export interface CredentialRequest {
  readonly url: string;
  readonly method: string;
  readonly now?: number;
}

export interface CredentialIssueInput {
  readonly name: string;
  readonly binding: CredentialBinding;
  readonly secret: string;
  readonly ttlMs?: number;
}

export interface CredentialHandle {
  readonly name: string;
  readonly token: string;
  readonly revision: number;
  readonly issuedAt: number;
  readonly expiresAt?: number;
}

export type CredentialStatus = "active" | "expired" | "revoked" | "stale" | "unknown";

export interface CredentialBroker {
  readonly revision: number;
  /** 快照中只有 handle 元数据，不含任何明文。 */
  readonly handles: readonly CredentialHandle[];
  issue(input: CredentialIssueInput): CredentialHandle;
  resolve(handle: CredentialHandle, request: CredentialRequest): Record<string, string>;
  revoke(name: string): void;
  rotate(name: string): CredentialHandle;
  /** 全局作废：提升 revision，此前签发的所有 handle 立即变 stale。 */
  invalidateAll(): void;
  status(handle: CredentialHandle, now?: number): CredentialStatus;
}

export interface CredentialBrokerOptions {
  readonly now?: () => number;
  /** 默认 Authorization: Bearer <secret>；显式给出时以 headerName: secret 注入。 */
  readonly headerName?: string;
}

/** provider / discovery / image / MCP 共用的边界引用：只有 handle，不含明文。 */
export interface CredentialBoundaryRef {
  readonly broker: CredentialBroker;
  readonly handle: CredentialHandle;
}

interface StoredCredential {
  readonly input: CredentialIssueInput;
  readonly handle: CredentialHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function pathSegmentsOf(pathname: string): readonly string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function bindingMatches(binding: CredentialBinding, request: CredentialRequest): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("INVALID_CREDENTIAL_URL");
  }
  if (url.protocol.slice(0, -1) !== binding.scheme) return false;
  if (url.hostname.toLowerCase() !== binding.host.toLowerCase()) return false;
  if (binding.port !== undefined && effectivePort(url) !== binding.port) return false;
  if (binding.methods !== undefined && !binding.methods.includes(request.method.toUpperCase())) return false;
  if (binding.pathSegments !== undefined) {
    const actual = pathSegmentsOf(url.pathname);
    if (binding.pathSegments.length > actual.length) return false;
    for (let index = 0; index < binding.pathSegments.length; index += 1) {
      if (binding.pathSegments[index] !== actual[index]) return false;
    }
  }
  return true;
}

export function createCredentialBroker(options: CredentialBrokerOptions = {}): CredentialBroker {
  const now = options.now ?? (() => Date.now());
  const headerName = options.headerName ?? "Authorization";
  const instanceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // 明文只存在于这个闭包 map 中；handles 快照与 JSON.stringify(broker) 都拿不到它。
  const secrets = new Map<string, StoredCredential>();
  const handles: CredentialHandle[] = [];
  const revoked = new Map<string, number>();
  let revision = 0;

  function statusOf(handle: CredentialHandle, at: number): CredentialStatus {
    if (!isRecord(handle) || typeof handle.token !== "string") return "unknown";
    const stored = secrets.get(handle.token);
    if (stored === undefined) return "unknown";
    // 只信 broker 闭包里的权威 handle：外部副本的 revision/expiresAt 篡改不能改变状态判定。
    const authoritative = stored.handle;
    const revocationRevision = revoked.get(authoritative.name);
    if (revocationRevision !== undefined && authoritative.revision <= revocationRevision) return "revoked";
    if (authoritative.revision !== revision) return "stale";
    if (authoritative.expiresAt !== undefined && at >= authoritative.expiresAt) return "expired";
    return "active";
  }

  function issue(input: CredentialIssueInput): CredentialHandle {
    if (!isRecord(input) || typeof input.name !== "string" || input.name.length === 0) {
      throw new Error("INVALID_CREDENTIAL_NAME");
    }
    if (typeof input.secret !== "string" || input.secret.length === 0) throw new Error("INVALID_CREDENTIAL_SECRET");
    if (!isRecord(input.binding) || input.binding.scheme.length === 0 || input.binding.host.length === 0) {
      throw new Error("INVALID_CREDENTIAL_BINDING");
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw new Error("INVALID_CREDENTIAL_TTL");
    }
    const issuedAt = now();
    const handle: CredentialHandle = Object.freeze({
      name: input.name,
      token: `__zeta_cred_${instanceId}_${handles.length}__`,
      revision,
      issuedAt,
      ...(input.ttlMs === undefined ? {} : { expiresAt: issuedAt + input.ttlMs }),
    });
    handles.push(handle);
    secrets.set(handle.token, { input, handle });
    return handle;
  }

  return {
    get revision(): number {
      return revision;
    },
    get handles(): readonly CredentialHandle[] {
      return handles.map((handle) => Object.freeze({ ...handle }));
    },
    issue,
    resolve(handle: CredentialHandle, request: CredentialRequest): Record<string, string> {
      if (!isRecord(handle) || typeof handle.token !== "string") throw new Error("INVALID_CREDENTIAL_HANDLE");
      const stored = secrets.get(handle.token);
      if (stored === undefined) throw new Error("UNKNOWN_CREDENTIAL");
      if (!isRecord(request)) throw new Error("INVALID_CREDENTIAL_REQUEST");
      if (!bindingMatches(stored.input.binding, request)) throw new Error("CREDENTIAL_BINDING_MISMATCH");
      const at = typeof request.now === "number" ? request.now : now();
      const status = statusOf(handle, at);
      if (status === "revoked") throw new Error("CREDENTIAL_REVOKED");
      if (status === "stale") throw new Error("CREDENTIAL_STALE");
      if (status === "expired") throw new Error("CREDENTIAL_EXPIRED");
      if (status !== "active") throw new Error("UNKNOWN_CREDENTIAL");
      const secret = stored.input.secret;
      return headerName === "Authorization" ? { Authorization: `Bearer ${secret}` } : { [headerName]: secret };
    },
    revoke(name: string): void {
      if (typeof name !== "string" || name.length === 0) throw new Error("INVALID_CREDENTIAL_NAME");
      revision += 1;
      revoked.set(name, revision);
    },
    rotate(name: string): CredentialHandle {
      const stored = [...secrets.values()].reverse().find((entry) => entry.input.name === name);
      if (stored === undefined) throw new Error("UNKNOWN_CREDENTIAL");
      revision += 1;
      return issue({ ...stored.input, name });
    },
    invalidateAll(): void {
      revision += 1;
    },
    status(handle: CredentialHandle, at?: number): CredentialStatus {
      if (!isRecord(handle) || typeof handle.token !== "string") return "unknown";
      return statusOf(handle, typeof at === "number" ? at : now());
    },
  };
}

/** 所有 provider / discovery / image / MCP 的出站请求共用的唯一注入点。 */
export function withCredentialFetch(
  broker: CredentialBroker,
  handle: CredentialHandle,
  fetchImpl: typeof fetch
): typeof fetch {
  if (typeof fetchImpl !== "function") throw new Error("INVALID_FETCH_IMPL");
  // 不转发底层 fetch 的 preconnect：它会绕过策略边界提前建连。
  const boundary = ((input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? request?.method ?? "GET";
    const secrets = broker.resolve(handle, { url, method });
    const headers = new Headers(request?.headers);
    if (init?.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    const querySecret = Object.entries(secrets).find(([name]) => {
      const lower = name.toLowerCase();
      return lower === "key" || lower === "x-goog-api-key";
    });
    for (const [name, value] of Object.entries(secrets)) {
      const lower = name.toLowerCase();
      if (lower !== "key" && lower !== "x-goog-api-key") headers.set(name, value);
    }
    let nextUrl = url;
    if (querySecret !== undefined) {
      const parsed = new URL(url);
      parsed.searchParams.set("key", querySecret[1]);
      nextUrl = parsed.toString();
    }
    if (request === undefined) return fetchImpl(nextUrl, { ...init, headers });

    // Request 输入重建为 Request：保留 method/body/signal，同时把合并后的头注入权威副本。
    let nextRequest = new Request(nextUrl, request);
    for (const [name, value] of headers) nextRequest.headers.set(name, value);
    if (init !== undefined && Object.keys(init).length > 0) {
      nextRequest = new Request(nextRequest, { ...init, headers });
    }
    return fetchImpl(nextRequest, undefined);
  }) as typeof fetch;
  return boundary;
}
