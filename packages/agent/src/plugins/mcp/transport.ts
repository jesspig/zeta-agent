import { createConnection, type Socket } from "node:net";
import type { Disposer } from "@zeta-agent/framework";
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpRequestOptions,
  McpTransport,
} from "./client";
import type { McpOAuthGrant, McpOAuthGrantManager } from "./oauth-grant";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listenerSet<T>(): {
  add(listener: (value: T) => void | Promise<void>): Disposer;
  emit(value: T): Promise<void>;
  clear(): void;
} {
  const listeners = new Set<(value: T) => void | Promise<void>>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async emit(value) {
      for (const listener of [...listeners]) await listener(value);
    },
    clear: () => listeners.clear(),
  };
}

/** 进程内 JSON-RPC 传输：测试与嵌入宿主可直接注入 request 处理器。 */
export function createInMemoryMcpTransport(options: {
  readonly request: (message: McpJsonRpcRequest, requestOptions?: McpRequestOptions) => McpJsonRpcResponse | Promise<McpJsonRpcResponse>;
}): McpTransport & {
  emitNotification(message: McpJsonRpcNotification): Promise<void>;
  emitRequest(message: McpJsonRpcRequest): Promise<void>;
  setRespond(respond: (message: McpJsonRpcResponse) => void | Promise<void>): void;
} {
  const notifications = listenerSet<McpJsonRpcNotification>();
  const requests = listenerSet<McpJsonRpcRequest>();
  let respond: ((message: McpJsonRpcResponse) => void | Promise<void>) | undefined;
  let disposed = false;
  return {
    async request(message, requestOptions) {
      if (disposed) throw new Error("MCP_TRANSPORT_DISPOSED");
      return options.request(message, requestOptions);
    },
    async notify(message) {
      await notifications.emit(message);
    },
    onNotification: (listener) => notifications.add(listener),
    onRequest: (listener) => requests.add(listener),
    setRespond(next) {
      respond = next;
    },
    async respond(message) {
      if (respond === undefined) throw new Error("MCP_TRANSPORT_RESPONDER_MISSING");
      await respond(message);
    },
    async emitNotification(message) {
      await notifications.emit(message);
    },
    async emitRequest(message) {
      await requests.emit(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      notifications.clear();
      requests.clear();
    },
  };
}

/** 把行分隔字节流切成完整的 JSON-RPC 消息并分派（stdio/socket 共用）。 */
function dispatchLines(
  chunk: string,
  buffer: { value: string },
  onMessage: (message: Record<string, unknown>) => void
): void {
  buffer.value += chunk;
  const lines = buffer.value.split("\n");
  buffer.value = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") continue;
    onMessage(message);
  }
}

/** stdio 帧通道：每行一个 JSON-RPC 消息，写入/读取由宿主通过回调绑定。 */
export function createStdioMcpTransport(options: {
  readonly write: (line: string) => void | Promise<void>;
  /** 宿主把 server 输出按行喂入：调用 onLine(整行字符串)。 */
  readonly feed: (onLine: (line: string) => void) => Disposer;
}): McpTransport {
  const notifications = listenerSet<McpJsonRpcNotification>();
  const requests = listenerSet<McpJsonRpcRequest>();
  const pending = new Map<number, (response: McpJsonRpcResponse) => void>();
  let disposed = false;
  const stopFeed = options.feed((line) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") return;
    if (typeof parsed.id === "number") {
      const resolve = pending.get(parsed.id);
      if (resolve !== undefined) {
        pending.delete(parsed.id);
        resolve(parsed as unknown as McpJsonRpcResponse);
      }
    } else if (typeof parsed.method === "string") {
      void notifications.emit(parsed as unknown as McpJsonRpcNotification);
    }
  });
  const send = async (message: unknown): Promise<void> => {
    if (disposed) throw new Error("MCP_TRANSPORT_DISPOSED");
    await options.write(`${JSON.stringify(message)}\n`);
  };
  return {
    async request(message) {
      const response = new Promise<McpJsonRpcResponse>((resolve) => pending.set(message.id, resolve));
      await send(message);
      return response;
    },
    notify: (message) => send(message),
    onNotification: (listener) => notifications.add(listener),
    onRequest: (listener) => requests.add(listener),
    respond: (message) => send(message),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFeed();
      pending.clear();
      notifications.clear();
      requests.clear();
    },
  };
}

/** text/event-stream 帧：每个 SSE 事件以空行结束，data: 行拼接为 JSON 消息。 */
export function encodeHttpSse(message: McpJsonRpcRequest | McpJsonRpcResponse | McpJsonRpcNotification): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

export function decodeHttpSse(frame: string): readonly (McpJsonRpcResponse | McpJsonRpcNotification)[] {
  const messages: (McpJsonRpcResponse | McpJsonRpcNotification)[] = [];
  for (const block of frame.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) continue;
      if (typeof parsed.id === "number") messages.push(parsed as unknown as McpJsonRpcResponse);
      else if (typeof parsed.method === "string") messages.push(parsed as unknown as McpJsonRpcNotification);
    } catch {
      continue;
    }
  }
  return messages;
}

export interface HttpMcpTransportOptions {
  readonly url: string;
  readonly fetchImpl: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
  /** 可选 SSE 订阅（GET），用于接收服务器通知。 */
  readonly sse?: boolean;
  /** OAuth 凭据由 grant manager 绑定注入；401 时串行刷新后重试一次。 */
  readonly oauth?: { readonly manager: McpOAuthGrantManager; readonly grant: McpOAuthGrant };
}

/** streamable-http/sse 共用传输：POST JSON-RPC，GET SSE 收通知；凭据由 headers 注入。 */
export function createHttpMcpTransport(options: HttpMcpTransportOptions): McpTransport & {
  readonly readySse: () => Promise<void>;
} {
  const notifications = listenerSet<McpJsonRpcNotification>();
  const requests = listenerSet<McpJsonRpcRequest>();
  const sseController = new AbortController();
  let sseReady: Promise<void> | undefined;
  let disposed = false;
  const baseHeaders = (url: string, method = "POST"): Headers => {
    const headers = new Headers(options.headers ?? {});
    if (options.oauth !== undefined) {
      for (const [name, value] of Object.entries(options.oauth.manager.headers(options.oauth.grant, url, method))) {
        headers.set(name, value);
      }
    }
    headers.set("content-type", "application/json");
    if (options.sessionId !== undefined) headers.set("mcp-session-id", options.sessionId);
    return headers;
  };
  const consumeFrame = (frame: string): void => {
    for (const message of decodeHttpSse(frame)) {
      if ("method" in message) {
        if ("id" in message && typeof message.id === "number") {
          void requests.emit(message as McpJsonRpcRequest);
        } else {
          void notifications.emit(message as McpJsonRpcNotification);
        }
      }
    }
  };
  const readySse = async (): Promise<void> => {
    if (!options.sse || sseReady !== undefined) return;
    sseReady = (async () => {
      const response = await options.fetchImpl(options.url, {
        method: "GET",
        headers: baseHeaders(options.url, "GET"),
        signal: sseController.signal,
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const blocks = buffered.split(/\r?\n\r?\n/);
          buffered = blocks.pop() ?? "";
          for (const block of blocks) consumeFrame(`${block}\n\n`);
        }
      } finally {
        reader.releaseLock();
      }
    })();
    await sseReady.catch(() => {});
  };
  return {
    async request(message, requestOptions) {
      if (disposed) throw new Error("MCP_TRANSPORT_DISPOSED");
      const send = (): Promise<Response> => options.fetchImpl(options.url, {
        method: "POST",
        headers: baseHeaders(options.url, "POST"),
        body: JSON.stringify(message),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      let response = await send();
      if (response.status === 401 && options.oauth !== undefined) {
        await options.oauth.manager.refresh(options.oauth.grant, requestOptions?.signal);
        response = await send();
      }
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const text = await response.text();
      if (text.length === 0) throw new Error("MCP_HTTP_EMPTY_RESPONSE");
      const match = decodeHttpSse(text).find(
        (candidate): candidate is McpJsonRpcResponse =>
          "id" in candidate && candidate.id === message.id
      );
      if (match === undefined) throw new Error("MCP_HTTP_RESPONSE_MISMATCH");
      return match;
    },
    async notify(message) {
      if (disposed) throw new Error("MCP_TRANSPORT_DISPOSED");
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: baseHeaders(options.url, "POST"),
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
    },
    onNotification: (listener) => notifications.add(listener),
    onRequest: (listener) => requests.add(listener),
    async respond(message) {
      await options.fetchImpl(options.url, {
        method: "POST",
        headers: baseHeaders(options.url, "POST"),
        body: JSON.stringify(message),
      });
    },
    readySse,
    dispose() {
      if (disposed) return;
      disposed = true;
      sseController.abort();
      notifications.clear();
      requests.clear();
    },
  };
}

/** socket 行分隔传输：由注入的 host/port 建立真实 TCP 连接，按 id 分派响应。 */
export function createSocketMcpTransport(options: {
  readonly host: string;
  readonly port: number;
  readonly connect?: (options: { readonly host: string; readonly port: number }) => Socket;
}): McpTransport {
  const socket = (options.connect ?? ((config: { readonly host: string; readonly port: number }) =>
    createConnection({ host: config.host, port: config.port })))({ host: options.host, port: options.port });
  const notifications = listenerSet<McpJsonRpcNotification>();
  const requests = listenerSet<McpJsonRpcRequest>();
  const pending = new Map<number, (response: McpJsonRpcResponse) => void>();
  let disposed = false;
  const buffer = { value: "" };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    dispatchLines(chunk, buffer, (message) => {
      if (typeof message.id === "number") {
        const resolve = pending.get(message.id);
        if (resolve !== undefined) {
          pending.delete(message.id);
          resolve(message as unknown as McpJsonRpcResponse);
        } else {
          void requests.emit(message as unknown as McpJsonRpcRequest);
        }
      } else if (typeof message.method === "string") {
        void notifications.emit(message as unknown as McpJsonRpcNotification);
      }
    });
  });
  const send = async (message: McpJsonRpcRequest | McpJsonRpcResponse | McpJsonRpcNotification): Promise<void> => {
    if (disposed) throw new Error("MCP_TRANSPORT_DISPOSED");
    await new Promise<void>((resolve, reject) => {
      socket.write(`${JSON.stringify(message)}\n`, (error) => (error == null ? resolve() : reject(error)));
    });
  };
  return {
    async request(message) {
      const response = new Promise<McpJsonRpcResponse>((resolve) => pending.set(message.id, resolve));
      await send(message);
      return response;
    },
    notify: (message) => send(message),
    onNotification: (listener) => notifications.add(listener),
    onRequest: (listener) => requests.add(listener),
    respond: (message) => send(message),
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      notifications.clear();
      requests.clear();
      socket.destroy();
    },
  };
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** 统一分页：游标去重 + deadline 防护，避免恶意 server 的循环游标挂死客户端。 */
export async function paginate<T>(options: {
  readonly fetchPage: (cursor: string | undefined) => Promise<Page<T>>;
  readonly deadlineMs?: number;
  readonly maxPages?: number;
}): Promise<readonly T[]> {
  const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;
  const maxPages = options.maxPages ?? 1000;
  const seen = new Set<string>();
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    if (deadline !== undefined && Date.now() > deadline) throw new Error("MCP_PAGINATION_TIMEOUT");
    if (cursor !== undefined) {
      if (seen.has(cursor)) return items;
      seen.add(cursor);
    }
    const result = await options.fetchPage(cursor);
    if (cursor !== undefined && result.nextCursor === cursor) return items;
    items.push(...result.items);
    if (result.nextCursor === undefined || result.nextCursor.length === 0) return items;
    cursor = result.nextCursor;
  }
  throw new Error("MCP_PAGINATION_LIMIT");
}

export function nextPageCursor(response: unknown): string | undefined {
  if (!isRecord(response) || typeof response.nextCursor !== "string" || response.nextCursor.length === 0) {
    return undefined;
  }
  return response.nextCursor;
}
