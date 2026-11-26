import { describe, expect, test } from "bun:test";
import { createServer, createConnection, type Socket } from "node:net";
import type { McpJsonRpcRequest, McpJsonRpcResponse } from "./client";
import {
  createHttpMcpTransport,
  createInMemoryMcpTransport,
  createSocketMcpTransport,
  createStdioMcpTransport,
  decodeHttpSse,
  encodeHttpSse,
  paginate,
} from "./transport";

const ok = (request: McpJsonRpcRequest, result: unknown): McpJsonRpcResponse => ({
  jsonrpc: "2.0",
  id: request.id,
  result,
});

describe("T-17 transport 与分页", () => {
  test("① stdio 帧：换行分隔、逐帧解析请求/响应/通知", async () => {
    const frames: string[] = [];
    let deliver: ((line: string) => void) | undefined;
    const transport = createStdioMcpTransport({
      write: (line) => {
        frames.push(line);
      },
      feed: (onLine) => {
        deliver = onLine;
        return () => {
          deliver = undefined;
        };
      },
    });
    const pending = transport.request({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(JSON.parse(frames[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    deliver?.(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { pong: true } }));
    await expect(pending).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { pong: true } });
    transport.dispose();
    expect(deliver).toBeUndefined();
  });

  test("② HTTP SSE：事件帧编解码往返，解析 data: 行", () => {
    const message: McpJsonRpcResponse = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    const frame = encodeHttpSse(message);
    expect(frame).toContain("data: ");
    expect(decodeHttpSse(frame)).toEqual([message]);
    expect(decodeHttpSse("event: ping\ndata: {}\n\n")).toEqual([]);
  });

  test("③ HTTP transport：POST 带 Authorization/ContentType/session，可选 GET SSE 订阅", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let sseAborted = false;
    const transport = createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), init: init ?? {} });
        if ((init?.method ?? "GET") === "GET") {
          const signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => {
            sseAborted = true;
          });
          return new Response(encodeHttpSse({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), {
            status: 200,
          });
        }
        return new Response(
          encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch,
      headers: { Authorization: "Bearer test" },
      sessionId: "sess-1",
      sse: true,
    });
    const response = await transport.request({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.result).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://mcp.example.test/mcp");
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("mcp-session-id")).toBe("sess-1");
    await transport.readySse();
    expect(seen.some((item) => (item.init.method ?? "GET") === "GET")).toBe(true);
    transport.dispose();
    expect(sseAborted).toBe(true);
  });

  test("④ HTTP 非 2xx/RPC error 原样抛错，不静默兜底", async () => {
    const transport = createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(transport.request({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("HTTP_503");
  });

  test("⑤ socket transport：真实 TCP 服务器行分隔请求/响应与通知", async () => {
    const server = createServer((socket: Socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          const message = JSON.parse(line) as McpJsonRpcRequest;
          socket.write(`${JSON.stringify(ok(message, { echo: message.method }))}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("SOCKET_ADDRESS_MISSING");
    const transport = createSocketMcpTransport({ host: "127.0.0.1", port: address.port });
    await expect(transport.request({ jsonrpc: "2.0", id: 1, method: "ping" })).resolves.toEqual({
      jsonrpc: "2.0", id: 1, result: { echo: "ping" },
    });
    transport.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("⑦ HTTP OAuth：凭据按 grant 绑定注入，401 串行刷新后重试", async () => {
    const { createCredentialBroker } = await import("@zeta-agent/security");
    const { createMcpOAuthGrantManager } = await import("./oauth-grant");
    const manager = createMcpOAuthGrantManager({
      broker: createCredentialBroker(),
      exchange: async () => ({ token: "first" }),
      refresh: async () => ({ token: "second" }),
    });
    const grant = await manager.login(
      { id: "http", origin: "https://mcp.example.test", clientId: "c", scopes: ["tools"], tokenPath: "/mcp" },
      { code: "x" }
    );
    const seen: string[] = [];
    let first = true;
    const transport = createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      oauth: { manager, grant },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        if (first) {
          first = false;
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          { status: 200 }
        );
      }) as unknown as typeof fetch,
    });
    expect((await transport.request({ jsonrpc: "2.0", id: 1, method: "ping" })).result).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer first", "Bearer second"]);
  });

  test("⑧ HTTP transport 经统一出站客户端：默认拒绝、显式 allow、逐跳重定向拒绝", async () => {
    const { createOutboundClient } = await import("@zeta-agent/security");
    const calls: string[] = [];
    const sseFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        { status: 200 }
      );
    }) as typeof fetch;

    const denied = createOutboundClient({ egress: { allow: [] }, fetch: sseFetch });
    await expect(createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      fetchImpl: sseFetch,
      outbound: denied,
    }).request({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("EGRESS_ALLOW_REQUIRED");
    expect(calls).toEqual([]);

    const allowed = createOutboundClient({
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetch: sseFetch,
    });
    const okTransport = createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      fetchImpl: sseFetch,
      outbound: allowed,
    });
    expect((await okTransport.request({ jsonrpc: "2.0", id: 1, method: "ping" })).result).toEqual({ ok: true });
    expect(calls).toEqual(["https://mcp.example.test/mcp"]);

    let first = true;
    const redirectFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (first) {
        first = false;
        return new Response(null, { status: 302, headers: { location: "https://evil.test/mcp" } });
      }
      return new Response(encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    const redirectOutbound = createOutboundClient({
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetch: redirectFetch,
    });
    await expect(createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      fetchImpl: redirectFetch,
      outbound: redirectOutbound,
    }).request({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(2);
  });

  test("⑨ 注入裸 fetchImpl 无 allow 时拒绝；配置 allow 后走该 transport 且逐跳受控", async () => {
    const calls: string[] = [];
    const bareFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    const requestMessage: McpJsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "ping" };

    await expect(createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      fetchImpl: bareFetch,
    }).request(requestMessage)).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    expect(calls).toEqual([]);

    let first = true;
    const redirectFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (first) {
        first = false;
        return new Response(null, { status: 302, headers: { location: "https://evil.test/mcp" } });
      }
      return new Response(encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    await expect(createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetchImpl: redirectFetch,
    }).request(requestMessage)).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toEqual(["https://mcp.example.test/mcp"]);

    const successFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(encodeHttpSse({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    expect((await createHttpMcpTransport({
      url: "https://mcp.example.test/mcp",
      egress: { allow: [{ host: "mcp.example.test", port: 443 }] },
      fetchImpl: successFetch,
    }).request(requestMessage)).result).toEqual({ ok: true });
    expect(calls.at(-1)).toBe("https://mcp.example.test/mcp");
  });

  test("⑥ 分页：游标推进、deadline 与重复 id 防护", async () => {
    const pages = [
      { items: ["a", "b"], nextCursor: "p2" },
      { items: ["c"], nextCursor: undefined },
    ];
    let index = 0;
    const seenCursors: Array<string | undefined> = [];
    const items = await paginate({
      fetchPage: async (cursor) => {
        seenCursors.push(cursor);
        return pages[index++] ?? { items: [] };
      },
      deadlineMs: 100,
    });
    expect(items).toEqual(["a", "b", "c"]);
    expect(seenCursors).toEqual([undefined, "p2"]);

    const loops = await paginate({
      fetchPage: async () => ({ items: ["x"], nextCursor: "same" }),
      deadlineMs: 50,
    });
    expect(loops).toEqual(["x"]);
  });
});
