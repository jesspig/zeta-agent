import { describe, expect, test } from "bun:test";
import { createCredentialBroker } from "@zeta-agent/security";
import { encodeHttpSse, createHttpMcpTransport } from "./transport";
import { createMcpOAuthGrantManager } from "./oauth-grant";
import {
  authorizationUrl,
  createInMemoryMcpOAuthTokenStore,
  createMcpOAuthFlow,
  createMcpPkceChallenge,
  discoverMcpOAuthMetadata,
  parseAuthorizationCallback,
  type McpOAuthMetadata,
} from "./oauth-flow";

const ORIGIN = "https://mcp.example.test";
const REDIRECT = "http://127.0.0.1:7777/callback";
const SCOPES = ["tools:read", "tools:call"];
const METADATA_RESPONSE = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/authorize`,
  token_endpoint: `${ORIGIN}/token`,
  registration_endpoint: `${ORIGIN}/register`,
  scopes_supported: SCOPES,
};
const METADATA: McpOAuthMetadata = {
  issuer: ORIGIN,
  authorizationEndpoint: `${ORIGIN}/authorize`,
  tokenEndpoint: `${ORIGIN}/token`,
  registrationEndpoint: `${ORIGIN}/register`,
  scopesSupported: SCOPES,
};

function discoveryFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return new Response(JSON.stringify({ ...METADATA_RESPONSE, ...overrides }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function tokenFetch(tokens: readonly string[], calls: Array<Record<string, string>> = []): typeof fetch {
  let index = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push(Object.fromEntries(body.entries()));
      const accessToken = tokens[Math.min(index, tokens.length - 1)]!;
      index += 1;
      return new Response(JSON.stringify({
        access_token: accessToken,
        refresh_token: `refresh-${index}`,
        token_type: "Bearer",
        expires_in: 60,
        scope: SCOPES.join(" "),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return new Response(JSON.stringify(METADATA_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function flowOptions(metadata: McpOAuthMetadata, fetchImpl: typeof fetch) {
  const store = createInMemoryMcpOAuthTokenStore();
  return {
    store,
    options: {
      origin: ORIGIN,
      clientId: "zeta-client",
      redirectUri: REDIRECT,
      scopes: SCOPES,
      metadata,
      tokenStore: store,
      fetchImpl,
    },
  };
}

describe("T-19 MCP OAuth discovery/PKCE/callback/持久化/refresh/logout", () => {
  test("① discovery 校验 origin/issuer/端点同源；非安全 origin 与跨 origin 端点显式拒绝", async () => {
    const metadata = await discoverMcpOAuthMetadata({ origin: ORIGIN, fetchImpl: discoveryFetch() });
    expect(metadata.authorizationEndpoint).toBe(`${ORIGIN}/authorize`);
    expect(metadata.tokenEndpoint).toBe(`${ORIGIN}/token`);
    expect(metadata.scopesSupported).toEqual(SCOPES);

    await expect(discoverMcpOAuthMetadata({
      origin: "http://mcp.example.test",
      fetchImpl: discoveryFetch(),
    })).rejects.toThrow("MCP_OAUTH_INSECURE_ORIGIN");
    await expect(discoverMcpOAuthMetadata({
      origin: ORIGIN,
      fetchImpl: discoveryFetch({ token_endpoint: "https://evil.test/token" }),
    })).rejects.toThrow("MCP_OAUTH_TOKEN_ENDPOINT_ORIGIN_MISMATCH");
    await expect(discoverMcpOAuthMetadata({
      origin: ORIGIN,
      fetchImpl: discoveryFetch({ token_endpoint: undefined }),
    })).rejects.toThrow("MCP_OAUTH_INCOMPLETE_METADATA");
  });

  test("② PKCE S256 与授权 URL 绑定 client/scope/state", () => {
    const pkce = createMcpPkceChallenge();
    expect(pkce.method).toBe("S256");
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(authorizationUrl({
      authorizationEndpoint: `${ORIGIN}/authorize`,
      clientId: "zeta-client",
      redirectUri: REDIRECT,
      scopes: SCOPES,
      state: "state-1",
      pkce,
    }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("client_id")).toBe("zeta-client");
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  test("③ callback 拒绝错误 state/error；成功后 token 持久化，refresh/ logout 阻断迟到结果", async () => {
    const calls: Array<Record<string, string>> = [];
    const { store, options } = flowOptions(METADATA, tokenFetch(["access-1", "access-2"], calls));
    const flow = createMcpOAuthFlow(options);

    expect(() => parseAuthorizationCallback(`${REDIRECT}?code=x&state=WRONG`, {
      expectedState: flow.state, origin: ORIGIN, clientId: "zeta-client", scopes: SCOPES,
    })).toThrow("MCP_OAUTH_STATE_MISMATCH");
    expect(() => parseAuthorizationCallback(`${REDIRECT}?error=access_denied&state=${flow.state}`, {
      expectedState: flow.state, origin: ORIGIN, clientId: "zeta-client", scopes: SCOPES,
    })).toThrow("MCP_OAUTH_CALLBACK_ERROR");

    const token = await flow.handleCallback(`${REDIRECT}?code=abc&state=${encodeURIComponent(flow.state)}`);
    expect(token.accessToken).toBe("access-1");
    expect(store.load(flow.tokenKey)?.accessToken).toBe("access-1");
    expect(calls[0]?.grant_type).toBe("authorization_code");
    expect(calls[0]?.code_verifier).toBe(flow.pkce.verifier);

    const refreshed = await flow.refresh();
    expect(refreshed.accessToken).toBe("access-2");
    expect(store.load(flow.tokenKey)?.accessToken).toBe("access-2");
    expect(calls[1]?.grant_type).toBe("refresh_token");

    flow.logout();
    expect(store.load(flow.tokenKey)).toBeUndefined();
    await expect(flow.refresh()).rejects.toThrow("MCP_OAUTH_LOGGED_OUT");
    await expect(flow.handleCallback(`${REDIRECT}?code=late&state=${encodeURIComponent(flow.state)}`))
      .rejects.toThrow("MCP_OAUTH_LOGGED_OUT");
    expect(store.load(flow.tokenKey)).toBeUndefined();
  });

  test("④ 同一 (origin,client,scope) 键跨 flow 共享持久化 token", async () => {
    const { store, options } = flowOptions(METADATA, tokenFetch(["persisted"]));
    const first = createMcpOAuthFlow(options);
    await first.handleCallback(`${REDIRECT}?code=abc&state=${encodeURIComponent(first.state)}`);
    const second = createMcpOAuthFlow(options);
    expect(second.tokenKey).toBe(first.tokenKey);
    expect(store.load(second.tokenKey)?.accessToken).toBe("persisted");
  });

  test("⑤ 并发 refresh 合并为一次 token 请求", async () => {
    let release!: (value: { access_token: string }) => void;
    const calls: Array<Record<string, string>> = [];
    let tokenCalls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        calls.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries()));
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return new Response(JSON.stringify({
            access_token: "seed", refresh_token: "r1", token_type: "Bearer", scope: SCOPES.join(" "),
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Promise<Response>((resolve) => {
          release = (value) => resolve(new Response(JSON.stringify({
            ...value, token_type: "Bearer", scope: SCOPES.join(" "),
          }), { status: 200, headers: { "content-type": "application/json" } }));
        });
      }
      return new Response(JSON.stringify(METADATA_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { store, options } = flowOptions(METADATA, fetchImpl);
    const flow = createMcpOAuthFlow(options);
    await flow.handleCallback(`${REDIRECT}?code=abc&state=${encodeURIComponent(flow.state)}`);
    store.save(flow.tokenKey, { accessToken: "seed", refreshToken: "r1" });

    const one = flow.refresh();
    const two = flow.refresh();
    await Promise.resolve();
    expect(calls.filter((call) => call.grant_type === "refresh_token")).toHaveLength(1);
    release({ access_token: "merged" });
    await Promise.all([one, two]);
    expect(store.load(flow.tokenKey)?.accessToken).toBe("merged");
  });

  test("⑥ flow token 经 grant manager 注入 HTTP transport：401 后刷新重试闭环", async () => {
    const { store, options } = flowOptions(METADATA, tokenFetch(["flow-token", "refreshed-token"]));
    const flow = createMcpOAuthFlow(options);
    await flow.handleCallback(`${REDIRECT}?code=abc&state=${encodeURIComponent(flow.state)}`);

    const manager = createMcpOAuthGrantManager({
      broker: createCredentialBroker(),
      exchange: async () => {
        const record = store.load(flow.tokenKey);
        if (record === undefined) throw new Error("MCP_OAUTH_TOKEN_MISSING");
        return { token: record.accessToken, ttlMs: 60_000 };
      },
      refresh: async () => {
        const record = await flow.refresh();
        return { token: record.accessToken, ttlMs: 60_000 };
      },
    });
    const grant = await manager.login({
      id: "flow-http", origin: ORIGIN, clientId: "zeta-client", scopes: SCOPES, tokenPath: "/mcp",
    }, { code: "already-exchanged" });

    const authHeaders: string[] = [];
    let first = true;
    const transport = createHttpMcpTransport({
      url: `${ORIGIN}/mcp`,
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      oauth: { manager, grant },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (first) {
          first = false;
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
      }) as typeof fetch,
    });
    expect((await transport.request({ jsonrpc: "2.0", id: 1, method: "ping" })).result).toEqual({ ok: true });
    expect(authHeaders).toEqual(["Bearer flow-token", "Bearer refreshed-token"]);
    transport.dispose();
  });
});
