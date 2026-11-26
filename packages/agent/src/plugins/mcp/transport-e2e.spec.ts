import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { createMcpConnection, type McpJsonRpcRequest, type McpJsonRpcResponse } from "./client";
import { createMcpProtocol, MCP_PROTOCOL_VERSION, type McpProtocol } from "./protocol";
import { createHttpMcpTransport, createSocketMcpTransport, createStdioMcpTransport } from "./transport";

const FIXTURE = join(import.meta.dir, "__fixtures__", "mcp-server.ts");
const SESSION = { realm: "mcp:e2e", assertUsable: () => {} };
const ROOTS = [{ uri: "file:///workspace", name: "workspace" }];

function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function reply(message: McpJsonRpcRequest, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id: message.id, result };
}

function fixtureHandle(message: McpJsonRpcRequest): McpJsonRpcResponse {
  if (message.method === "initialize") {
    return reply(message, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: "real-fixture", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return reply(message, { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  }
  if (message.method === "tools/call") {
    const params = message.params as { arguments: { text: string } };
    return reply(message, { content: [{ type: "text", text: params.arguments.text }] });
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NO" } };
}

describe("T-19 三 transport 真实字节 E2E", () => {
  test("① stdio：真实子进程 newline 分帧（写入被拆半），握手/列工具/调用往返", async () => {
    const child = Bun.spawn([process.execPath, FIXTURE], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const written: string[] = [];
    let rawWrites = 0;
    let deliverChunk: (chunk: string) => void = () => {};
    const transport = createStdioMcpTransport({
      write: (frame) => {
        written.push(frame);
        child.stdin.write(frame);
        rawWrites += 1;
      },
      feedBytes: (onChunk) => {
        deliverChunk = onChunk;
        return () => {
          deliverChunk = () => {};
        };
      },
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        // 真实字节可能任意切片：7 字符一片喂入，transport 必须按换行重组。
        for (let offset = 0; offset < text.length; offset += 7) deliverChunk(text.slice(offset, offset + 7));
      }
    })();
    try {
      const connection = await createMcpConnection({
        server: { name: "e2e-stdio", transport: "stdio", command: "bun" },
        transport,
        session: SESSION,
      });
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect(await connection.callTool("echo", { text: "wire" })).toMatchObject({
        content: [{ type: "text", text: "wire" }],
      });
      expect(written.length).toBeGreaterThan(0);
      expect(written.every((frame) => frame.endsWith("\n"))).toBe(true);
      expect(written.every((frame) => typeof JSON.parse(frame).method === "string")).toBe(true);
      expect(rawWrites).toBe(written.length);
      connection.dispose();
    } finally {
      child.stdin.end();
      await pump.catch(() => {});
      await child.exited.catch(() => {});
    }
  }, 30_000);

  test("② HTTP：POST JSON 原始字节 + mcp-session-id + SSE 响应与 server→client 请求", async () => {
    const requestBodies: string[] = [];
    const sessionIds: (string | string[] | undefined)[] = [];
    const serverFrames: string[] = [];
    const server = createHttpServer((req, res) => {
      if (req.method === "GET") {
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "roots/list", params: {} })}\n\n`;
        serverFrames.push(frame);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frame);
        return;
      }
      sessionIds.push(req.headers["mcp-session-id"]);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requestBodies.push(body);
        const message = JSON.parse(body) as McpJsonRpcRequest;
        const frame = `data: ${JSON.stringify(fixtureHandle(message))}\n\n`;
        serverFrames.push(frame);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frame);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("HTTP_ADDRESS_MISSING");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const transport = createHttpMcpTransport({
      url,
      egress: { allow: [{ host: "127.0.0.1", port: address.port }] },
      fetchImpl: fetch,
      sessionId: "sess-e2e",
      sse: true,
    });
    try {
      transport.onRequest?.((message) => {
        if (message.method === "roots/list") {
          void transport.respond?.({ jsonrpc: "2.0", id: message.id, result: { roots: ROOTS } });
        }
      });
      await transport.readySse();
      const connection = await createMcpConnection({
        server: { name: "e2e-http", transport: "streamable-http", url },
        transport,
        session: SESSION,
      });
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect(await connection.callTool("echo", { text: "sse" })).toMatchObject({
        content: [{ type: "text", text: "sse" }],
      });
      expect(requestBodies.length).toBeGreaterThan(0);
      expect(requestBodies.every((body) => !body.startsWith("data: ") && typeof JSON.parse(body).jsonrpc === "string")).toBe(true);
      expect(requestBodies.some((body) => typeof JSON.parse(body).method === "string")).toBe(true);
      expect(sessionIds.every((id) => id === "sess-e2e")).toBe(true);
      expect(serverFrames.every((frame) => frame.startsWith("data: ") && frame.endsWith("\n\n"))).toBe(true);
      expect(requestBodies.some((body) => {
        const message = JSON.parse(body) as McpJsonRpcResponse;
        return message.id === 77 && JSON.stringify(message.result) === JSON.stringify({ roots: ROOTS });
      })).toBe(true);
      connection.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  test("③ socket 真实 TCP：server request、分页、tools_changed generation/debounce 都走原始字节行", async () => {
    const receivedLines: string[] = [];
    let listCalls = 0;
    const server = createServer((socket: Socket) => {
      let buffer = "";
      const send = (message: unknown): void => {
        socket.write(line(message));
      };
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        receivedLines.push(text);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.length === 0) continue;
          const message = JSON.parse(raw) as McpJsonRpcRequest;
          if (message.method === "initialize") {
            send(reply(message, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "tcp-fixture", version: "1" },
            }));
            setTimeout(() => send({ jsonrpc: "2.0", id: 77, method: "roots/list", params: {} }), 80);
            setTimeout(() => {
              send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
              send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
            }, 110);
            continue;
          }
          if (message.method === "tools/list") {
            listCalls += 1;
            const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
            send(reply(message, cursor === undefined
              ? { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "p2" }
              : { tools: [{ name: "b", inputSchema: { type: "object" } }] }));
            continue;
          }
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NO" } });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("SOCKET_ADDRESS_MISSING");
    const transport = createSocketMcpTransport({ host: "127.0.0.1", port: address.port });
    try {
      const connection = await createMcpConnection({
        server: { name: "e2e-socket", transport: "sse", url: "tcp://unused" },
        transport,
        session: SESSION,
        toolsChangedDebounceMs: 25,
      });
      connection.onRequest("roots/list", () => ({ roots: ROOTS }));
      const observed: string[][] = [];
      connection.onToolsChanged((tools) => {
        observed.push(tools.map((tool) => tool.name));
      });
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["a", "b"]);
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(observed).toEqual([["a", "b"]]);
      expect(listCalls).toBe(4); // 初始 2 页 + debounce 后刷新 2 页
      expect(receivedLines.some((text) => text.includes('"id":77') && text.includes('"result"'))).toBe(true);
      expect(receivedLines.every((text) => text.includes("\n"))).toBe(true);
      connection.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  test("④ socket 真实字节：超时与 abort 先发 cancelled，迟到响应不提交", async () => {
    const lines: string[] = [];
    const server = createServer((socket: Socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        lines.push(text);
        buffer += text;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const raw of parts) {
          if (raw.length === 0) continue;
          const message = JSON.parse(raw) as McpJsonRpcRequest;
          if (message.method === "initialize") socket.write(line(reply(message, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "slow", version: "1" },
          })));
          // tools/list / ping 故意不响应，以驱动客户端超时与取消。
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("SOCKET_ADDRESS_MISSING");
    const transport = createSocketMcpTransport({ host: "127.0.0.1", port: address.port });
    let protocol: McpProtocol | undefined;
    try {
      protocol = await createMcpProtocol(transport);
      await expect(protocol.request("tools/list", {}, { timeoutMs: 25 })).rejects.toThrow("MCP_TIMEOUT");
      const controller = new AbortController();
      const pending = protocol.request("ping", {}, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow("MCP_ABORTED");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancelled = lines.flatMap((text) => text.split("\n"))
        .filter((raw) => raw.includes("notifications/cancelled"))
        .map((raw) => JSON.parse(raw) as { params: { reason: string } });
      expect(cancelled.map((item) => item.params.reason)).toEqual(["MCP_TIMEOUT", "MCP_ABORTED"]);
      expect(lines.every((text) => text.includes("\n"))).toBe(true);
    } finally {
      protocol?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
