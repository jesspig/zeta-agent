import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { createMcpConnection } from "./client";
import { createHttpMcpTransport, createStdioMcpTransport } from "./transport";

const FIXTURE = join(import.meta.dir, "__fixtures__", "mcp-server.ts");
const SERVER = { name: "e2e", transport: "stdio" as const, command: "bun" };
const session = { realm: "mcp:e2e", assertUsable: () => {} };

interface ServerRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function handle(message: ServerRequest): unknown {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    return reply({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: "real-fixture", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return reply({
      tools: [{
        name: "echo",
        description: "echo input",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
      }],
    });
  }
  if (message.method === "tools/call") {
    const params = message.params as { name: string; arguments: { text: string } };
    if (params.name !== "echo") return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "UNKNOWN_TOOL" } };
    return reply({ content: [{ type: "text", text: params.arguments.text }], structuredContent: { text: params.arguments.text } });
  }
  if (message.method === "resources/list") return reply({ resources: [{ uri: "file:///fixture.txt", name: "fixture" }] });
  if (message.method === "prompts/list") return reply({ prompts: [{ name: "greet" }] });
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "METHOD_NOT_FOUND" } };
}

describe("T-17 真实 MCP server E2E", () => {
  test("① 真实 stdio server：握手、列工具与调用往返", async () => {
    const child = Bun.spawn([process.execPath, FIXTURE], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    let deliver: ((line: string) => void) | undefined;
    const transport = createStdioMcpTransport({
      write: (line) => {
        child.stdin.write(line);
      },
      feed: (onLine) => {
        deliver = onLine;
        return () => {
          deliver = undefined;
        };
      },
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.length > 0) deliver?.(line);
      }
    })();
    try {
      const connection = await createMcpConnection({ server: SERVER, transport, session });
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(tools[0]?.inputSchema).toMatchObject({ properties: { text: { type: "string" } } });
      expect((tools[0] as { outputSchema?: unknown }).outputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });
      expect(await connection.callTool("echo", { text: "hello" })).toMatchObject({
        content: [{ type: "text", text: "hello" }],
        structuredContent: { text: "hello" },
      });
      expect(await connection.listResources()).toEqual([{ uri: "file:///fixture.txt", name: "fixture" }]);
      connection.dispose();
    } finally {
      child.stdin.end();
      await pump.catch(() => {});
      await child.exited.catch(() => {});
    }
  }, 30_000);

  test("② 真实 HTTP server：POST JSON-RPC + SSE 响应，列工具并调用", async () => {
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        const message = JSON.parse(body) as ServerRequest;
        const response = handle(message);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(response)}\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("HTTP_ADDRESS_MISSING");
    const transport = createHttpMcpTransport({
      url: `http://127.0.0.1:${address.port}/mcp`,
      egress: { allow: [{ host: "127.0.0.1", port: address.port }] },
      fetchImpl: fetch,
    });
    try {
      const connection = await createMcpConnection({
        server: { name: "e2e-http", transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
        transport,
        session,
      });
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect(await connection.callTool("echo", { text: "http" })).toMatchObject({
        structuredContent: { text: "http" },
      });
      expect(await connection.listPrompts()).toEqual([{ name: "greet" }]);
      connection.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
