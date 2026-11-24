import { isCriticalLayerDegraded, type ExecutionBackend } from "@zeta-agent/security";
import type { Disposer } from "@zeta-agent/framework";
import type { McpServerConfig } from "./config";
import { createMcpProtocol } from "./protocol";
import { nextPageCursor, paginate } from "./transport";

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: McpToolAnnotations;
  readonly [key: string]: unknown;
}

export interface McpCallResult {
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly [key: string]: unknown;
}

/** stdio/socket 的字节通道由 ExecutionBackend 会话显式绑定，调用方无法绕过。 */
export interface McpSession {
  readonly realm: string;
  assertUsable(): void;
}

export interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface McpJsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** 单次请求的取消/超时边界；传输实现应把它传给底层 I/O（如 fetch 的 signal）。 */
export interface McpRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * 最小 JSON-RPC 2.0 传输接口；真实 stdio/socket 只允许经此接口注入，不内置进程/网络实现。
 * notify/respond/onRequest 可选：旧传输只需 request/onNotification 即可继续工作，
 * 但完整协议（initialized/cancelled/roots）需要它们。
 */
export interface McpTransport {
  request(message: McpJsonRpcRequest, options?: McpRequestOptions): Promise<McpJsonRpcResponse>;
  notify?(message: McpJsonRpcNotification): void | Promise<void>;
  onNotification(listener: (message: McpJsonRpcNotification) => void | Promise<void>): Disposer;
  onRequest?(listener: (message: McpJsonRpcRequest) => void | Promise<void>): Disposer;
  respond?(message: McpJsonRpcResponse): void | Promise<void>;
  dispose(): void;
}

export type McpTransportFactory = (
  server: McpServerConfig,
  session: McpSession
) => McpTransport | Promise<McpTransport>;

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface McpConnection {
  readonly server: string;
  /** 返回当前已知工具清单（通知到达时已先刷新）。 */
  listTools(): Promise<readonly McpToolDescriptor[]>;
  /** 显式刷新；tools/list_changed 时由连接自动调用。 */
  refresh(): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult>;
  onToolsChanged(listener: (tools: readonly McpToolDescriptor[]) => void | Promise<void>): Disposer;
  listResources(): Promise<readonly McpResourceDescriptor[]>;
  readResource(uri: string): Promise<unknown>;
  listPrompts(): Promise<readonly McpPromptDescriptor[]>;
  getPrompt(name: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
  listRoots(): Promise<readonly unknown[]>;
  onRequest(
    method: string,
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  ): Disposer;
  dispose(): void;
}

export interface McpConnectionOptions {
  readonly server: McpServerConfig;
  readonly transport: McpTransport;
  readonly session: McpSession;
  /** tools/list_changed 合并窗口（毫秒）；缺省 10ms。 */
  readonly toolsChangedDebounceMs?: number;
  readonly pageDeadlineMs?: number;
  readonly handshake?: McpRequestOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTools(value: readonly unknown[]): readonly McpToolDescriptor[] {
  const tools: McpToolDescriptor[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
      throw new Error("MCP_INVALID_TOOL_DESCRIPTOR");
    }
    // 协议字段（inputSchema/outputSchema/title 等）原样保留，不做扁平化或丢弃。
    tools.push({
      ...item,
      name: item.name,
      ...(isRecord(item.annotations) ? { annotations: item.annotations as McpToolAnnotations } : {}),
    } as McpToolDescriptor);
  }
  return tools;
}

/**
 * 为 stdio/socket server 打开 ExecutionBackend 会话。会话的 realm 由 server 名派生，
 * backend.run 绑定该 realm；能力非 active 时失败关闭，绝不落到真实进程/端口。
 */
export async function openMcpSession(server: McpServerConfig, backend: ExecutionBackend): Promise<McpSession> {
  const realm = `mcp:${server.name}`;
  const argv = server.transport === "stdio"
    ? ["mcp:session", "stdio", server.name, server.command, ...(server.args ?? [])]
    : ["mcp:session", server.transport, server.name, server.url];
  const assertUsable = (): void => {
    if (isCriticalLayerDegraded(backend.capabilities())) throw new Error("CRITICAL_LAYER_DEGRADED");
  };
  assertUsable();
  // 返回值仅用于确认后端接受该 realm 绑定；会话本身不启动真实进程（transport 由注入方提供）。
  await backend.run({ argv }, { realm });
  return { realm, assertUsable };
}

/** 最小 MCP 客户端：握手、分页、工具清单 generation/debounce 与 resources/prompts/roots。 */
export async function createMcpConnection(options: McpConnectionOptions): Promise<McpConnection> {
  const { server, transport, session } = options;
  if (typeof transport.request !== "function") throw new Error("MCP_TRANSPORT_REQUIRED");
  const protocol = await createMcpProtocol(transport, options.handshake ?? {});
  let tools: readonly McpToolDescriptor[] = [];
  const listeners = new Set<(tools: readonly McpToolDescriptor[]) => void | Promise<void>>();
  let disposed = false;
  let generation = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debounceMs = options.toolsChangedDebounceMs ?? 10;

  async function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    session.assertUsable();
    if (disposed) throw new Error("MCP_CONNECTION_DISPOSED");
    return protocol.request(method, params);
  }

  async function paged<T>(
    method: string,
    key: string,
    params: Record<string, unknown> = {}
  ): Promise<readonly T[]> {
    return paginate<T>({
      ...(options.pageDeadlineMs === undefined ? {} : { deadlineMs: options.pageDeadlineMs }),
      fetchPage: async (cursor) => {
        const result = await request(method, { ...params, ...(cursor === undefined ? {} : { cursor }) });
        if (!isRecord(result) || !Array.isArray(result[key])) throw new Error(`MCP_INVALID_${key.toUpperCase()}`);
        return {
          items: result[key] as readonly T[],
          ...(nextPageCursor(result) === undefined ? {} : { nextCursor: nextPageCursor(result) }),
        };
      },
    });
  }

  async function refresh(): Promise<readonly McpToolDescriptor[]> {
    const found = await paged<McpToolDescriptor>("tools/list", "tools");
    tools = parseTools(found);
    return tools;
  }

  async function flushChanged(expected: number): Promise<void> {
    if (disposed) return;
    const next = await refresh();
    if (expected !== generation) return;
    for (const listener of [...listeners]) await listener(next);
  }

  const offNotification = transport.onNotification((message) => {
    if (message.method !== "notifications/tools/list_changed") return;
    generation += 1;
    const current = generation;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flushChanged(current).catch(() => {});
    }, debounceMs);
  });

  await refresh();

  return {
    server: server.name,
    listTools: async () => tools,
    async refresh() {
      generation += 1;
      return refresh();
    },
    async callTool(name, args) {
      const result = await request("tools/call", { name, arguments: { ...args } });
      if (!isRecord(result)) throw new Error("MCP_INVALID_CALL_RESULT");
      return result as McpCallResult;
    },
    onToolsChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async listResources() {
      return paged<McpResourceDescriptor>("resources/list", "resources");
    },
    async readResource(uri) {
      return request("resources/read", { uri });
    },
    async listPrompts() {
      return paged<McpPromptDescriptor>("prompts/list", "prompts");
    },
    async getPrompt(name, args) {
      return request("prompts/get", { name, ...(args === undefined ? {} : { arguments: { ...args } }) });
    },
    async listRoots() {
      return paged<unknown>("roots/list", "roots");
    },
    onRequest(method, handler) {
      return protocol.onRequest(method, handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      offNotification();
      listeners.clear();
      protocol.dispose();
    },
  };
}
