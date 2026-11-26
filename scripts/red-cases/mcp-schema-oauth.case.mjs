/**
 * RED-14：MCP schema 生产请求保真 + OAuth discovery/PKCE/callback 显式闭环。
 * 本地 fixture，不访问外网。
 */
import { createContext } from "../../packages/framework/src/index.ts";
import {
  createEgressPolicy,
  createExecutionBackend,
} from "../../packages/components/security/src/index.ts";
import { createAgent } from "../../packages/agent/src/facade.ts";
import { installMcpPlugin } from "../../packages/agent/src/plugins/mcp/index.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/facade.ts:2046-2058（toToolSchema 只投影扁平 parameters，丢弃 MCP input/outputSchema）" +
  " / packages/agent/src/plugins/mcp/oauth-grant.ts:87-92（login 直接接受 code，无 discovery/PKCE/callback）";

const SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "query text" },
    nested: {
      type: "object",
      description: "nested options",
      properties: {
        flags: { type: "array", items: { type: "string" }, description: "flag list" },
        depth: { type: "integer", description: "nested depth" },
      },
      required: ["flags"],
    },
  },
  required: ["text", "nested"],
};
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { rows: { type: "array", items: { type: "object" }, description: "result rows" } },
  required: ["rows"],
};

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function probeSchema() {
  const listeners = new Set();
  const backend = createExecutionBackend({
    name: "red14",
    capabilities: {
      isolation: "active", seccomp: "active", fsConfinement: "active",
      auditSink: "active", egressDefaultDeny: "active",
    },
    executor: () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
  });
  const transport = {
    async request(message) {
      const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
      if (message.method === "initialize") {
        return result({
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "red14", version: "1" },
        });
      }
      if (message.method === "tools/list") {
        return result({ tools: [{ name: "find", description: "search", inputSchema: SCHEMA, outputSchema: OUTPUT_SCHEMA }] });
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NO" } };
    },
    async notify() {},
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRequest() { return () => {}; },
    async respond() {},
    dispose() {},
  };
  let requestTools = undefined;
  let turn = 0;
  const ctx = createContext();
  const agent = createAgent({
    includeBuiltins: false,
    coreContext: ctx,
    egressPolicy: createEgressPolicy(),
    streamFn: async function* (request) {
      turn += 1;
      if (turn === 1) requestTools = request.tools;
      yield "done";
    },
  });
  const handle = installMcpPlugin({
    api: agent.api,
    ctx,
    backend,
    transportFactory: () => transport,
    servers: [{ name: "red14", transport: "stdio", command: "fake" }],
  });
  try {
    await handle.ready;
    await agent.prompt("go");
    const tool = (requestTools ?? []).find((item) => item.name === "mcp__red14__find");
    return {
      requestTools,
      inputSchemaPreserved: tool !== undefined && sameJson(tool.inputSchema, SCHEMA),
      outputSchemaPreserved: tool !== undefined && sameJson(tool.outputSchema, OUTPUT_SCHEMA),
    };
  } finally {
    await handle.dispose();
    agent.disposeAll();
  }
}

async function probeOAuth() {
  let flowModule;
  try {
    flowModule = await import("../../packages/agent/src/plugins/mcp/oauth-flow.ts");
  } catch (error) {
    return {
      moduleLoaded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const httpCalls = [];
  const fixtureFetch = async (input, init = {}) => {
    const url = String(input);
    httpCalls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return new Response(JSON.stringify({
        issuer: "https://mcp.example.test",
        authorization_endpoint: "https://mcp.example.test/authorize",
        token_endpoint: "https://mcp.example.test/token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/token")) {
      return new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  let insecureRejected = false;
  try {
    await flowModule.discoverMcpOAuthMetadata({ origin: "http://mcp.example.test", fetchImpl: fixtureFetch });
  } catch (error) {
    insecureRejected = String(error?.message ?? "").includes("MCP_OAUTH");
  }

  const metadata = await flowModule.discoverMcpOAuthMetadata({
    origin: "https://mcp.example.test",
    fetchImpl: fixtureFetch,
  });
  const store = flowModule.createInMemoryMcpOAuthTokenStore();
  const flow = flowModule.createMcpOAuthFlow({
    origin: "https://mcp.example.test",
    clientId: "red14-client",
    redirectUri: "http://127.0.0.1:7777/callback",
    scopes: ["tools:read"],
    metadata,
    tokenStore: store,
    fetchImpl: fixtureFetch,
  });
  const authUrl = new URL(flow.authorizationUrl);
  const pkceBound = authUrl.searchParams.get("code_challenge_method") === "S256"
    && (authUrl.searchParams.get("code_challenge") ?? "").length > 20
    && (authUrl.searchParams.get("state") ?? "") === flow.state
    && authUrl.searchParams.get("client_id") === "red14-client";

  let stateBound = false;
  try {
    flowModule.parseAuthorizationCallback(
      `http://127.0.0.1:7777/callback?code=abc&state=WRONG`,
      { expectedState: flow.state, origin: "https://mcp.example.test", clientId: "red14-client", scopes: ["tools:read"] }
    );
  } catch (error) {
    stateBound = String(error?.message ?? "").includes("MCP_OAUTH_STATE_MISMATCH");
  }

  const callbackUrl = `http://127.0.0.1:7777/callback?code=abc&state=${encodeURIComponent(flow.state)}`;
  const token = await flow.handleCallback(callbackUrl);
  const persisted = store.load(flow.tokenKey)?.accessToken === "access-1";
  const refreshed = await flow.refresh();
  const refreshPersisted = store.load(flow.tokenKey)?.accessToken === "access-1";
  flow.logout();
  const logoutCleared = store.load(flow.tokenKey) === undefined;

  return {
    moduleLoaded: true,
    insecureRejected,
    pkceBound,
    stateBound,
    token: token.accessToken,
    persisted,
    refreshed: refreshed.accessToken,
    refreshPersisted,
    logoutCleared,
    httpCalls: httpCalls.map((call) => call.url),
  };
}

export default {
  id: "RED-14-mcp-schema-oauth",
  title: "MCP schema 必须进入生产 provider 请求；OAuth 必须 discovery/PKCE/callback/持久化且失败关闭",
  expectation:
    "streamFn 收到的 request.tools 中 MCP 工具保留完整嵌套 input/outputSchema（含 required/description）；" +
    "OAuth 有显式 discovery/PKCE/state 校验/callback/token 持久化/refresh/logout，非安全 origin 显式拒绝，不静默降级",
  target: "AC-19",
  async probe() {
    const schema = await probeSchema();
    const oauth = await probeOAuth();
    const actual = { schema, oauth };
    const schemaOk = schema.inputSchemaPreserved === true && schema.outputSchemaPreserved === true;
    const oauthOk = oauth.moduleLoaded === true
      && oauth.insecureRejected === true
      && oauth.pkceBound === true
      && oauth.stateBound === true
      && oauth.token === "access-1"
      && oauth.persisted === true
      && oauth.refreshed === "access-1"
      && oauth.refreshPersisted === true
      && oauth.logoutCleared === true;
    if (schemaOk && oauthOk) {
      return green(actual, "facade providerToolSchemas 保真 + oauth-flow.ts discovery/PKCE/callback/store/refresh/logout");
    }
    const reasons = [];
    if (!schemaOk) reasons.push("provider 请求丢失或扁平化了 MCP 嵌套 input/outputSchema");
    if (!oauthOk) reasons.push("OAuth 无 discovery/PKCE/state 闭环或静默降级");
    return red(actual, reasons.join("；"), EVIDENCE);
  },
};
