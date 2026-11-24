import { isCriticalLayerDegraded, type ExecutionBackend } from "@zeta-agent/security";
import type { Disposer } from "@zeta-agent/framework";
import type { McpServerConfig } from "./config";

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
  readonly annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
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

/** 最小 JSON-RPC 2.0 传输接口；真实 stdio/socket 只允许经此接口注入，不内置进程/网络实现。 */
export interface McpTransport {
  request(message: McpJsonRpcRequest): Promise<McpJsonRpcResponse>;
  onNotification(listener: (message: McpJsonRpcNotification) => void | Promise<void>): Disposer;
  dispose(): void;
}

export type McpTransportFactory = (
  server: McpServerConfig,
  session: McpSession
) => McpTransport | Promise<McpTransport>;

export interface McpConnection {
  readonly server: string;
  /** 返回当前已知工具清单（通知到达时已先刷新）。 */
  listTools(): Promise<readonly McpToolDescriptor[]>;
  /** 显式刷新；tools/list_changed 时由连接自动调用。 */
  refresh(): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult>;
  onToolsChanged(listener: (tools: readonly McpToolDescriptor[]) => void | Promise<void>): Disposer;
  dispose(): void;
}

export interface McpConnectionOptions {
  readonly server: McpServerConfig;
  readonly transport: McpTransport;
  readonly session: McpSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTools(value: unknown): readonly McpToolDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) throw new Error("MCP_INVALID_TOOLS_LIST");
  const tools: McpToolDescriptor[] = [];
  for (const item of value.tools) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
      throw new Error("MCP_INVALID_TOOL_DESCRIPTOR");
    }
    tools.push({
      name: item.name,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(item.inputSchema === undefined ? {} : { inputSchema: item.inputSchema }),
      ...(isRecord(item.annotations) ? { annotations: item.annotations as McpToolAnnotations } : {}),
    });
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

/** 最小 MCP 客户端：JSON-RPC 请求、工具清单缓存、list_changed 失效与关闭。 */
export async function createMcpConnection(options: McpConnectionOptions): Promise<McpConnection> {
  const { server, transport, session } = options;
  if (typeof transport.request !== "function") throw new Error("MCP_TRANSPORT_REQUIRED");
  let nextId = 0;
  let tools: readonly McpToolDescriptor[] = [];
  const listeners = new Set<(tools: readonly McpToolDescriptor[]) => void | Promise<void>>();
  let disposed = false;

  async function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    session.assertUsable();
    if (disposed) throw new Error("MCP_CONNECTION_DISPOSED");
    nextId += 1;
    const id = nextId;
    const response = await transport.request({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (!isRecord(response) || response.jsonrpc !== "2.0" || response.id !== id) {
      throw new Error("MCP_INVALID_RESPONSE");
    }
    if (response.error !== undefined) {
      const error = response.error;
      const message = isRecord(error) && typeof error.message === "string" ? error.message : "MCP_RPC_ERROR";
      throw new Error(message);
    }
    return response.result;
  }

  async function refresh(): Promise<readonly McpToolDescriptor[]> {
    tools = parseTools(await request("tools/list", {}));
    return tools;
  }

  const offNotification = transport.onNotification((message) => {
    if (message.method !== "notifications/tools/list_changed") return;
    return (async () => {
      const next = await refresh();
      for (const listener of [...listeners]) await listener(next);
    })();
  });

  await refresh();

  return {
    server: server.name,
    listTools: async () => tools,
    refresh,
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
    dispose() {
      if (disposed) return;
      disposed = true;
      offNotification();
      listeners.clear();
      transport.dispose();
    },
  };
}
