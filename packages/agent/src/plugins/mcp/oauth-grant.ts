import {
  createCredentialBroker,
  type CredentialBroker,
  type CredentialHandle,
} from "@zeta-agent/security";

export interface McpOAuthGrantSpec {
  readonly id: string;
  /** 精确 origin（scheme://host[:port]），凭据只对它可用。 */
  readonly origin: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly tokenPath: string;
}

export interface McpOAuthGrant extends McpOAuthGrantSpec {
  /** 由 CredentialBroker 签发，只有 handle 暴露，明文留在 broker 闭包内。 */
  readonly handle: CredentialHandle;
  readonly generation: number;
}

export interface McpOAuthToken {
  readonly token: string;
  readonly ttlMs?: number;
}

export interface McpOAuthGrantManager {
  readonly pendingCount: number;
  login(spec: McpOAuthGrantSpec, args: { readonly code: string }): Promise<McpOAuthGrant>;
  /** 同一 grant 的并发刷新串行合并；取消时清理在途状态并丢弃迟到结果。 */
  refresh(grant: McpOAuthGrant, signal?: AbortSignal): Promise<McpOAuthToken>;
  headers(grant: McpOAuthGrant, url: string, method?: string): Record<string, string>;
  revoke(grant: McpOAuthGrant): void;
}

export interface McpOAuthGrantOptions {
  readonly broker?: CredentialBroker;
  /** 真实 code 兑换；缺省复用 refresh（测试注入）。 */
  readonly exchange?: (args: { readonly code: string }) => Promise<McpOAuthToken>;
  /** 真实 token endpoint 刷新实现。 */
  readonly refresh: (signal?: AbortSignal) => Promise<McpOAuthToken>;
}

function bindingOf(spec: McpOAuthGrantSpec): { readonly url: URL; readonly pathSegments: readonly string[] } {
  let url: URL;
  try {
    url = new URL(spec.origin);
  } catch {
    throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("MCP_OAUTH_INVALID_ORIGIN");
  const path = new URL(spec.tokenPath, url);
  if (path.origin !== url.origin) throw new Error("MCP_OAUTH_TOKEN_PATH_MISMATCH");
  return {
    url,
    pathSegments: path.pathname.split("/").filter((segment) => segment.length > 0),
  };
}

/**
 * MCP OAuth grant：把 token 经统一 CredentialBroker 绑定到 origin/path/method，
 * 并把 clientId/scopes 作为额外身份约束。刷新按 grant 串行，取消即作废旧代次。
 */
export function createMcpOAuthGrantManager(options: McpOAuthGrantOptions): McpOAuthGrantManager {
  const broker = options.broker ?? createCredentialBroker();
  const inflight = new Map<string, { generation: number; promise: Promise<McpOAuthToken> }>();
  const generations = new Map<string, number>();
  const grants = new Map<string, McpOAuthGrant>();

  function assertBinding(grant: McpOAuthGrant): void {
    const current = grants.get(grant.id);
    if (current === undefined) throw new Error("MCP_OAUTH_UNKNOWN_GRANT");
    if (
      current.origin !== grant.origin ||
      current.clientId !== grant.clientId ||
      current.scopes.join(" ") !== grant.scopes.join(" ")
    ) {
      throw new Error("MCP_OAUTH_BINDING_MISMATCH");
    }
  }

  return {
    get pendingCount() {
      return inflight.size;
    },
    async login(spec, args) {
      bindingOf(spec);
      if (args.code.length === 0) throw new Error("MCP_OAUTH_EMPTY_CODE");
      const token = options.exchange === undefined
        ? await options.refresh()
        : await options.exchange(args);
      const { url, pathSegments } = bindingOf(spec);
      const binding = {
        scheme: url.protocol.slice(0, -1) as "http" | "https",
        host: url.hostname,
        port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
        pathSegments,
        methods: ["POST"],
      };
      const handle = broker.issue({
        name: `mcp-oauth:${spec.id}`,
        binding,
        secret: token.token,
        ...(token.ttlMs === undefined ? {} : { ttlMs: token.ttlMs }),
      });
      const generation = (generations.get(spec.id) ?? 0) + 1;
      generations.set(spec.id, generation);
      const grant: McpOAuthGrant = { ...spec, scopes: [...spec.scopes], handle, generation };
      grants.set(spec.id, grant);
      return grant;
    },
    refresh(grant, signal) {
      assertBinding(grant);
      if (signal?.aborted === true) return Promise.reject(new Error("MCP_OAUTH_CANCELLED"));
      const existing = inflight.get(grant.id);
      if (existing !== undefined) return existing.promise;
      const generation = grant.generation;
      const work = options.refresh(signal);
      const onAbort = (): void => {
        generations.set(grant.id, generation + 1);
        inflight.delete(grant.id);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const promise = work.then(
        (token) => {
          if (signal?.aborted === true) throw new Error("MCP_OAUTH_CANCELLED");
          if (token.token.length === 0) throw new Error("MCP_OAUTH_EMPTY_TOKEN");
          const { url, pathSegments } = bindingOf(grant);
          const handle = broker.issue({
            name: `mcp-oauth:${grant.id}`,
            binding: {
              scheme: url.protocol.slice(0, -1) as "http" | "https",
              host: url.hostname,
              port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
              pathSegments,
              methods: ["POST"],
            },
            secret: token.token,
            ...(token.ttlMs === undefined ? {} : { ttlMs: token.ttlMs }),
          });
          const updated: McpOAuthGrant = { ...grant, handle, generation: generation + 1 };
          grants.set(grant.id, updated);
          return token;
        }
      );
      const tracked = promise.finally(() => {
        signal?.removeEventListener("abort", onAbort);
        inflight.delete(grant.id);
      });
      inflight.set(grant.id, { generation, promise: tracked });
      return tracked;
    },
    headers(grant, url, method = "POST") {
      assertBinding(grant);
      const current = grants.get(grant.id)!;
      // origin/path/method 绑定由 CredentialBroker 强制执行，避免两处规则漂移。
      // 刷新会替换 handle；注册表始终保存最新句柄，旧 grant 引用仍解析到新 token。
      return broker.resolve(current.handle, { url, method });
    },
    revoke(grant) {
      assertBinding(grant);
      broker.revoke(`mcp-oauth:${grant.id}`);
      generations.set(grant.id, grant.generation + 1);
    },
  };
}
