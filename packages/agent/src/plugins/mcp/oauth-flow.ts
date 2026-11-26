import { createHash, randomBytes } from "node:crypto";

/**
 * MCP OAuth 显式闭环：RFC 8414 discovery → PKCE(S256) → authorization/callback →
 * token 持久化 → refresh → logout。全部端点必须绑定同一 origin；非安全 origin、
 * state 不匹配、scope 漂移、迟到结果一律显式拒绝，绝不静默降级。
 */

export interface McpOAuthMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly jwksUri?: string;
  readonly scopesSupported?: readonly string[];
}

export interface McpOAuthDiscoveryOptions {
  readonly origin: string;
  readonly fetchImpl: typeof fetch;
  /** 相对 metadata 路径，缺省 /.well-known/oauth-authorization-server；必须同源。 */
  readonly metadataPath?: string;
}

export interface McpOAuthPkceChallenge {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export interface McpOAuthTokenRecord {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly scope?: string;
}

export interface McpOAuthTokenStore {
  load(key: string): McpOAuthTokenRecord | undefined;
  save(key: string, record: McpOAuthTokenRecord): void;
  delete(key: string): void;
}

export interface McpOAuthFlowOptions {
  readonly origin: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly metadata: McpOAuthMetadata;
  readonly tokenStore: McpOAuthTokenStore;
  readonly fetchImpl: typeof fetch;
  readonly pkce?: McpOAuthPkceChallenge;
  readonly state?: string;
}

export interface McpOAuthCallbackOptions {
  readonly expectedState: string;
  readonly origin: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly redirectUri?: string;
}

export interface McpOAuthFlow {
  readonly state: string;
  readonly tokenKey: string;
  readonly authorizationUrl: string;
  readonly pkce: McpOAuthPkceChallenge;
  handleCallback(url: string, signal?: AbortSignal): Promise<McpOAuthTokenRecord>;
  refresh(signal?: AbortSignal): Promise<McpOAuthTokenRecord>;
  logout(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(bytes: number): string {
  return base64url(new Uint8Array(randomBytes(bytes)));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** 严格 origin：scheme://host[:port]，无路径/查询/片段；非 loopback 明文拒绝。 */
function parseOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  if (isLoopback(url.hostname)) {
    // loopback 允许明文，便于本地 fixture；其他 host 必须 HTTPS。
  } else if (url.protocol !== "https:") {
    throw new Error("MCP_OAUTH_INSECURE_ORIGIN");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  if (url.search !== "" || url.hash !== "") throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  return url;
}

function assertSameOrigin(endpoint: string, origin: URL, label: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`MCP_OAUTH_INVALID_${label}`);
  }
  if (url.origin !== origin.origin) throw new Error(`MCP_OAUTH_${label}_ORIGIN_MISMATCH`);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error(`MCP_OAUTH_INSECURE_${label}`);
  }
  return url;
}

/** RFC 8414 / MCP 授权元数据发现；任何字段缺失或跨 origin 都失败关闭。 */
export async function discoverMcpOAuthMetadata(options: McpOAuthDiscoveryOptions): Promise<McpOAuthMetadata> {
  const origin = parseOrigin(options.origin);
  const metadataPath = options.metadataPath ?? "/.well-known/oauth-authorization-server";
  if (!metadataPath.startsWith("/") || metadataPath.startsWith("//")) throw new Error("MCP_OAUTH_INVALID_METADATA_PATH");
  const url = new URL(metadataPath, origin);
  if (url.origin !== origin.origin) throw new Error("MCP_OAUTH_METADATA_ORIGIN_MISMATCH");
  const response = await options.fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MCP_OAUTH_DISCOVERY_HTTP_${response.status}`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("MCP_OAUTH_INVALID_METADATA");
  }
  if (!isRecord(raw)) throw new Error("MCP_OAUTH_INVALID_METADATA");
  const issuer = typeof raw.issuer === "string" ? raw.issuer : undefined;
  const authorizationEndpoint = typeof raw.authorization_endpoint === "string" ? raw.authorization_endpoint : undefined;
  const tokenEndpoint = typeof raw.token_endpoint === "string" ? raw.token_endpoint : undefined;
  if (issuer === undefined || authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new Error("MCP_OAUTH_INCOMPLETE_METADATA");
  }
  if (parseOrigin(issuer).origin !== origin.origin) throw new Error("MCP_OAUTH_ISSUER_MISMATCH");
  assertSameOrigin(authorizationEndpoint, origin, "AUTHORIZATION_ENDPOINT");
  assertSameOrigin(tokenEndpoint, origin, "TOKEN_ENDPOINT");
  if (raw.registration_endpoint !== undefined) {
    if (typeof raw.registration_endpoint !== "string") throw new Error("MCP_OAUTH_INVALID_REGISTRATION_ENDPOINT");
    assertSameOrigin(raw.registration_endpoint, origin, "REGISTRATION_ENDPOINT");
  }
  if (raw.jwks_uri !== undefined) {
    if (typeof raw.jwks_uri !== "string") throw new Error("MCP_OAUTH_INVALID_JWKS_URI");
    assertSameOrigin(raw.jwks_uri, origin, "JWKS_URI");
  }
  const scopesSupported = Array.isArray(raw.scopes_supported)
    ? raw.scopes_supported.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(raw.registration_endpoint === undefined ? {} : { registrationEndpoint: raw.registration_endpoint }),
    ...(raw.jwks_uri === undefined ? {} : { jwksUri: raw.jwks_uri }),
    ...(scopesSupported === undefined ? {} : { scopesSupported }),
  };
}

/** PKCE S256：verifier 32 字节随机，challenge = base64url(SHA-256(verifier))。 */
export function createMcpPkceChallenge(
  random: () => Uint8Array = () => new Uint8Array(randomBytes(32))
): McpOAuthPkceChallenge {
  const bytes = random();
  if (bytes.length < 32) throw new Error("MCP_OAUTH_PKCE_WEAK_RANDOM");
  const verifier = base64url(bytes);
  const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge, method: "S256" };
}

export function authorizationUrl(options: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly pkce: McpOAuthPkceChallenge;
}): string {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** callback 解析：state 必须逐字匹配，code 必须非空；错误参数显式拒绝。 */
export function parseAuthorizationCallback(url: string, options: McpOAuthCallbackOptions): { readonly code: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP_OAUTH_INVALID_CALLBACK_URL");
  }
  if (options.redirectUri !== undefined) {
    const expected = new URL(options.redirectUri);
    if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) {
      throw new Error("MCP_OAUTH_REDIRECT_MISMATCH");
    }
  }
  const error = parsed.searchParams.get("error");
  if (error !== null) throw new Error(`MCP_OAUTH_CALLBACK_ERROR: ${error}`);
  const state = parsed.searchParams.get("state");
  if (state === null || state !== options.expectedState) throw new Error("MCP_OAUTH_STATE_MISMATCH");
  const code = parsed.searchParams.get("code");
  if (code === null || code.length === 0) throw new Error("MCP_OAUTH_MISSING_CODE");
  if (options.origin.length === 0 || options.clientId.length === 0 || options.scopes.length === 0) {
    throw new Error("MCP_OAUTH_BINDING_INCOMPLETE");
  }
  return { code };
}

export function createInMemoryMcpOAuthTokenStore(): McpOAuthTokenStore {
  const records = new Map<string, McpOAuthTokenRecord>();
  return {
    load: (key) => records.get(key),
    save: (key, record) => {
      records.set(key, record);
    },
    delete: (key) => {
      records.delete(key);
    },
  };
}

function tokenKeyOf(origin: string, clientId: string, scopes: readonly string[]): string {
  return `${origin}|${clientId}|${scopes.join(" ")}`;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly scope?: string;
}

async function requestToken(
  options: McpOAuthFlowOptions,
  body: Record<string, string>,
  signal?: AbortSignal
): Promise<TokenResponse> {
  const response = await options.fetchImpl(options.metadata.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`MCP_OAUTH_TOKEN_HTTP_${response.status}`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("MCP_OAUTH_INVALID_TOKEN_RESPONSE");
  }
  if (!isRecord(raw) || typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new Error("MCP_OAUTH_MISSING_ACCESS_TOKEN");
  }
  const tokenType = typeof raw.token_type === "string" ? raw.token_type.toLowerCase() : "bearer";
  if (tokenType !== "bearer") throw new Error("MCP_OAUTH_UNSUPPORTED_TOKEN_TYPE");
  return {
    accessToken: raw.access_token,
    ...(typeof raw.refresh_token === "string" && raw.refresh_token.length > 0 ? { refreshToken: raw.refresh_token } : {}),
    ...(typeof raw.expires_in === "number" && raw.expires_in > 0 ? { expiresAtMs: Date.now() + raw.expires_in * 1000 } : {}),
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
  };
}

/** 创建一次 OAuth 登录流程；token 以 (origin,clientId,scopes) 为键持久化。 */
export function createMcpOAuthFlow(options: McpOAuthFlowOptions): McpOAuthFlow {
  const origin = parseOrigin(options.origin);
  assertSameOrigin(options.metadata.authorizationEndpoint, origin, "AUTHORIZATION_ENDPOINT");
  assertSameOrigin(options.metadata.tokenEndpoint, origin, "TOKEN_ENDPOINT");
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "http:" && redirect.protocol !== "https:") throw new Error("MCP_OAUTH_INVALID_REDIRECT_URI");
  if (options.clientId.length === 0 || options.scopes.length === 0) throw new Error("MCP_OAUTH_BINDING_INCOMPLETE");
  const pkce = options.pkce ?? createMcpPkceChallenge();
  const state = options.state ?? randomToken(16);
  const tokenKey = tokenKeyOf(origin.origin, options.clientId, options.scopes);
  const url = authorizationUrl({
    authorizationEndpoint: options.metadata.authorizationEndpoint,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
    pkce,
  });

  let generation = 0;
  let loggedOut = false;
  let inflight: Promise<McpOAuthTokenRecord> | undefined;

  function guard(gen: number): void {
    if (loggedOut || gen !== generation) throw new Error("MCP_OAUTH_LOGGED_OUT");
  }

  function persist(response: TokenResponse, gen: number): McpOAuthTokenRecord {
    guard(gen);
    const previous = options.tokenStore.load(tokenKey);
    if (response.scope !== undefined) {
      const granted = new Set(response.scope.split(/\s+/).filter((item) => item.length > 0));
      if (!options.scopes.every((scope) => granted.has(scope))) throw new Error("MCP_OAUTH_SCOPE_MISMATCH");
    }
    const refreshToken = response.refreshToken ?? previous?.refreshToken;
    const record: McpOAuthTokenRecord = {
      accessToken: response.accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(response.expiresAtMs === undefined ? {} : { expiresAtMs: response.expiresAtMs }),
      ...(response.scope === undefined ? {} : { scope: response.scope }),
    };
    options.tokenStore.save(tokenKey, record);
    return record;
  }

  return {
    state,
    tokenKey,
    authorizationUrl: url,
    pkce,
    async handleCallback(callbackUrl, signal) {
      guard(generation);
      const { code } = parseAuthorizationCallback(callbackUrl, {
        expectedState: state,
        origin: origin.origin,
        clientId: options.clientId,
        scopes: options.scopes,
        redirectUri: options.redirectUri,
      });
      const response = await requestToken(options, {
        grant_type: "authorization_code",
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        code_verifier: pkce.verifier,
      }, signal);
      return persist(response, generation);
    },
    async refresh(signal) {
      guard(generation);
      if (inflight !== undefined) return inflight;
      const gen = generation;
      const current = options.tokenStore.load(tokenKey);
      if (current === undefined) throw new Error("MCP_OAUTH_TOKEN_MISSING");
      if (current.refreshToken === undefined) throw new Error("MCP_OAUTH_REFRESH_TOKEN_MISSING");
      const work = requestToken(options, {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: options.clientId,
        scope: options.scopes.join(" "),
      }, signal).then((response) => persist(response, gen));
      inflight = work.finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    logout() {
      loggedOut = true;
      generation += 1;
      options.tokenStore.delete(tokenKey);
    },
  };
}
