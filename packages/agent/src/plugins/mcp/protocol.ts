import type { Disposer } from "@zeta-agent/framework";
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpRequestOptions,
  McpTransport,
} from "./client";

/** 本客户端实现并声明支持的 MCP 协议版本（新版本在前，握手失败即拒绝）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2024-11-05",
]);

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeOptions {
  readonly protocolVersion?: string;
  readonly clientInfo?: McpClientInfo;
  readonly capabilities?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface McpProtocol {
  readonly initialized: boolean;
  readonly protocolVersion: string;
  readonly serverInfo: McpServerInfo;
  readonly serverCapabilities: Readonly<Record<string, unknown>>;
  request(method: string, params?: Record<string, unknown>, options?: McpRequestOptions): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  onRequest(
    method: string,
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  ): Disposer;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(response: McpJsonRpcResponse): Error {
  const error = response.error;
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "MCP_RPC_ERROR";
  return new Error(message);
}

/**
 * 完成 MCP 初始化握手并把 JSON-RPC 的取消/超时/服务器发起请求收敛到一处：
 * initialize → 校验版本与能力 → notifications/initialized。取消在途请求时先发
 * notifications/cancelled，迟到响应不提交；服务器请求按方法分派，未知方法返回 -32601。
 */
export async function createMcpProtocol(
  transport: McpTransport,
  options: McpInitializeOptions = {}
): Promise<McpProtocol> {
  if (typeof transport.request !== "function") throw new Error("MCP_TRANSPORT_REQUIRED");
  if (typeof transport.notify !== "function") throw new Error("MCP_TRANSPORT_NOTIFY_REQUIRED");

  let nextId = 0;
  let disposed = false;
  const handshakeOptions: McpRequestOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  async function rawRequest(
    message: McpJsonRpcRequest,
    requestOptions: McpRequestOptions = {}
  ): Promise<McpJsonRpcResponse> {
    return transport.request(message, requestOptions);
  }

  function checkResponse(response: unknown, id: number): McpJsonRpcResponse {
    if (!isRecord(response) || response.jsonrpc !== "2.0" || response.id !== id) {
      throw new Error("MCP_INVALID_RESPONSE");
    }
    return response as unknown as McpJsonRpcResponse;
  }

  const initId = ++nextId;
  const initResponse = checkResponse(
    await rawRequest(
      {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: options.capabilities ?? {},
          clientInfo: options.clientInfo ?? { name: "zeta", version: "1.0.0" },
        },
      },
      handshakeOptions
      ),
    initId
  );
  if (initResponse.error !== undefined) throw responseError(initResponse);
  const result = initResponse.result;
  if (!isRecord(result)) throw new Error("MCP_INVALID_INIT_RESULT");
  const protocolVersion = result.protocolVersion;
  if (typeof protocolVersion !== "string" || !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new Error("MCP_UNSUPPORTED_PROTOCOL_VERSION");
  }
  if (!isRecord(result.capabilities) || !isRecord(result.serverInfo)) {
    throw new Error("MCP_INVALID_INIT_RESULT");
  }
  const serverInfoValue = result.serverInfo;
  if (
    typeof serverInfoValue.name !== "string" ||
    typeof serverInfoValue.version !== "string" ||
    serverInfoValue.name.length === 0
  ) {
    throw new Error("MCP_INVALID_INIT_RESULT");
  }
  const serverInfo: McpServerInfo = { name: serverInfoValue.name, version: serverInfoValue.version };
  const serverCapabilities = result.capabilities as Readonly<Record<string, unknown>>;

  await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

  const handlers = new Map<string, Set<(params: Record<string, unknown>) => unknown | Promise<unknown>>>();
  const offRequest = transport.onRequest === undefined
    ? undefined
    : transport.onRequest((message) => {
        void (async () => {
          if (transport.respond === undefined) return;
          const bucket = handlers.get(message.method);
          if (bucket === undefined || bucket.size === 0) {
            await transport.respond({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `METHOD_NOT_FOUND: ${message.method}` },
            });
            return;
          }
          try {
            let outcome: unknown;
            for (const handler of [...bucket]) outcome = await handler(message.params ?? {});
            await transport.respond({ jsonrpc: "2.0", id: message.id, result: outcome });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await transport.respond({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: messageText },
            });
          }
        })();
      });

  return {
    initialized: true,
    protocolVersion,
    serverInfo,
    serverCapabilities,
    async request(method, params, requestOptions = {}) {
      if (disposed) throw new Error("MCP_PROTOCOL_DISPOSED");
      if (requestOptions.signal?.aborted === true) throw new Error("MCP_ABORTED");
      const id = ++nextId;
      let settled = false;
      let resolveResponse!: (response: McpJsonRpcResponse) => void;
      let rejectResponse!: (error: unknown) => void;
      const outcome = new Promise<McpJsonRpcResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const cancel = (reason: string): void => {
        if (settled) return;
        settled = true;
        void transport.notify?.({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason },
        });
        rejectResponse(new Error(reason));
      };
      const onAbort = (): void => cancel("MCP_ABORTED");
      requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = requestOptions.timeoutMs !== undefined && requestOptions.timeoutMs > 0
        ? setTimeout(() => cancel("MCP_TIMEOUT"), requestOptions.timeoutMs)
        : undefined;
      void rawRequest(
        {
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        },
        requestOptions
      ).then(
        (response) => {
          if (settled) return;
          settled = true;
          resolveResponse(response);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          rejectResponse(error);
        }
      );
      try {
        const response = checkResponse(await outcome, id);
        if (response.error !== undefined) throw responseError(response);
        return response.result;
      } finally {
        settled = true;
        requestOptions.signal?.removeEventListener("abort", onAbort);
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async notify(method, params) {
      if (disposed) throw new Error("MCP_PROTOCOL_DISPOSED");
      await transport.notify!({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      });
    },
    onRequest(method, handler) {
      let bucket = handlers.get(method);
      if (bucket === undefined) {
        bucket = new Set();
        handlers.set(method, bucket);
      }
      bucket.add(handler);
      return () => {
        bucket?.delete(handler);
        if (bucket?.size === 0) handlers.delete(method);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offRequest?.();
      handlers.clear();
      transport.dispose();
    },
  };
}

/** 把服务器通知载荷归一化为只读记录，非对象载荷一律拒绝。 */
export function notificationParams(message: McpJsonRpcNotification): Record<string, unknown> {
  if (!isRecord(message.params)) throw new Error("MCP_INVALID_NOTIFICATION");
  return message.params;
}
