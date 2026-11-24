import { describe, expect, test } from "bun:test";
import type { McpJsonRpcRequest, McpJsonRpcResponse, McpTransport } from "./client";
import { createMcpConnection, type McpCallResult } from "./client";
import { createInMemoryMcpTransport } from "./transport";
import {
  MCP_PROTOCOL_VERSION,
} from "./protocol";
import {
  projectMcpResult,
  type McpResultSink,
} from "./result-projection";

const SERVER = { name: "srv", transport: "stdio" as const, command: "fake" };
const session = { realm: "mcp:srv", assertUsable: () => {} };

interface HarnessOptions {
  tools?: (cursor: string | undefined) => { tools: unknown[]; nextCursor?: string };
}

function harness(options: HarnessOptions = {}) {
  const seen: McpJsonRpcRequest[] = [];
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const transport = createInMemoryMcpTransport({
    request: (message) => {
      seen.push(message);
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
            serverInfo: { name: "fake", version: "1" },
          },
        };
      }
      if (message.method === "tools/list") {
        const page = options.tools?.(params.cursor as string | undefined)
          ?? { tools: [{ name: "t", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] };
        return { jsonrpc: "2.0", id: message.id, result: page };
      }
      if (message.method === "tools/call") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "summary" }],
            structuredContent: { rows: [{ id: 1 }] },
          },
        };
      }
      if (message.method === "resources/list") {
        return { jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "file:///a.txt", name: "a" }] } };
      }
      if (message.method === "resources/read") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { contents: [{ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" }] },
        };
      }
      if (message.method === "prompts/list") {
        return { jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "p", description: "d" }] } };
      }
      if (message.method === "prompts/get") {
        return { jsonrpc: "2.0", id: message.id, result: { messages: [{ role: "user", content: { type: "text", text: "prompt" } }] } };
      }
      if (message.method === "roots/list") {
        return { jsonrpc: "2.0", id: message.id, result: { roots: [{ uri: "file:///workspace" }] } };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "METHOD_NOT_FOUND" } };
    },
  });
  const dispatched: McpJsonRpcResponse[] = [];
  transport.setRespond((response: McpJsonRpcResponse) => {
    dispatched.push(response);
  });
  return { transport, seen, notifications, dispatched };
}

describe("T-17 连接：分页、tools_changed generation/debounce、resources/prompts/roots", () => {
  test("① 握手后 tools/list 分页合并，inputSchema/outputSchema 原样保留", async () => {
    let call = 0;
    const h = harness({
      tools: (cursor) => {
        call += 1;
        return cursor === undefined
          ? { tools: [{ name: "a", inputSchema: { type: "object", properties: { x: { type: "number" } } }, outputSchema: { type: "object" } }], nextCursor: "p2" }
          : { tools: [{ name: "b", annotations: { readOnlyHint: true } }] };
      },
    });
    const connection = await createMcpConnection({
      server: SERVER,
      transport: h.transport,
      session,
    });
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: { x: { type: "number" } } });
    expect((tools[0] as { outputSchema?: unknown }).outputSchema).toEqual({ type: "object" });
    expect(call).toBe(2);
    // 握手先于任何 tools/list。
    const initializeIndex = h.seen.findIndex((message) => message.method === "initialize");
    const listIndex = h.seen.findIndex((message) => message.method === "tools/list");
    expect(initializeIndex).toBe(0);
    expect(listIndex).toBeGreaterThan(initializeIndex);
    connection.dispose();
  });

  test("② tools_changed 突发合并为一次刷新，generation 递增，旧通知不回退", async () => {
    let generation = 0;
    let current = ["old"];
    const h = harness({
      tools: () => {
        generation += 1;
        return { tools: current.map((name) => ({ name })), nextCursor: undefined };
      },
    });
    const connection = await createMcpConnection({
      server: SERVER,
      transport: h.transport,
      session,
      toolsChangedDebounceMs: 20,
    });
    const observed: string[][] = [];
    connection.onToolsChanged((tools) => {
      observed.push(tools.map((tool) => tool.name));
    });

    current = ["new1"];
    await h.transport.emitNotification({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    current = ["new2"];
    await h.transport.emitNotification({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["new2"]);
    // 突发通知被 debounce 合并，只刷新一次。
    expect(generation).toBe(2);
    expect(observed).toEqual([["new2"]]);

    connection.dispose();
    await expect(connection.refresh()).rejects.toThrow("MCP_CONNECTION_DISPOSED");
  });

  test("③ resources/prompts/roots 与 incoming request 经单一协议通道", async () => {
    const h = harness();
    const connection = await createMcpConnection({
      server: SERVER,
      transport: h.transport,
      session,
    });
    expect(await connection.listResources()).toEqual([{ uri: "file:///a.txt", name: "a" }]);
    expect(await connection.readResource("file:///a.txt")).toEqual({
      contents: [{ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" }],
    });
    expect(await connection.listPrompts()).toEqual([{ name: "p", description: "d" }]);
    expect(await connection.getPrompt("p")).toEqual({
      messages: [{ role: "user", content: { type: "text", text: "prompt" } }],
    });
    expect(await connection.listRoots()).toEqual([{ uri: "file:///workspace" }]);

    const off = connection.onRequest("sampling/createMessage", () => ({ role: "assistant", content: "ok" }));
    await h.transport.emitRequest({ jsonrpc: "2.0", id: 5, method: "sampling/createMessage" });
    expect(h.dispatched.at(-1)).toEqual({
      jsonrpc: "2.0", id: 5, result: { role: "assistant", content: "ok" },
    });
    off();
    connection.dispose();
  });

  test("④ 调用结果双投影：模型只看文本，结构数据与二进制资源不进模型", async () => {
    const saved: Array<{ uri: string; bytes: number }> = [];
    const sink: McpResultSink = {
      async saveResource(uri, data) {
        saved.push({ uri, bytes: data.byteLength });
        return `mcp-resource://${uri}`;
      },
    };
    const result: McpCallResult = {
      content: [
        { type: "text", text: "Found 1 row" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///secret.bin", blob: "AAAA" } },
      ],
      structuredContent: { rows: [{ id: 1, note: "SECRET-STRUCTURED-DETAIL" }] },
    };
    const projected = await projectMcpResult(result, { sink });
    expect(projected.content).toContain("Found 1 row");
    expect(projected.content).not.toContain("SECRET-STRUCTURED-DETAIL");
    expect(projected.content).not.toContain("AAAA");
    expect(projected.structuredContent).toEqual({ rows: [{ id: 1, note: "SECRET-STRUCTURED-DETAIL" }] });
    expect(saved.length).toBe(2);
    expect(projected.details?.resources).toMatchObject([
      { kind: "image", ref: expect.stringContaining("mcp-resource://") },
      { kind: "resource", ref: expect.stringContaining("mcp-resource://") },
    ]);
  });

  test("⑤ 无结构化内容时模型 content 仍保真，isError 原样传播", async () => {
    const projected = await projectMcpResult({ content: [{ type: "text", text: "plain" }], isError: true });
    expect(projected.content).toBe("plain");
    expect(projected.structuredContent).toBeUndefined();
    expect(projected.isError).toBe(true);
  });
});
