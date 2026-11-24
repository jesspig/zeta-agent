import { describe, expect, test } from "bun:test";
import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse } from "./client";
import { createMcpProtocol, MCP_PROTOCOL_VERSION } from "./protocol";
import { createInMemoryMcpTransport, paginate } from "./transport";
import { projectMcpResult } from "./result-projection";

function server(): {
  transport: ReturnType<typeof createInMemoryMcpTransport>;
  sent: McpJsonRpcRequest[];
  notified: McpJsonRpcNotification[];
} {
  const sent: McpJsonRpcRequest[] = [];
  const notified: McpJsonRpcNotification[] = [];
  const transport = createInMemoryMcpTransport({
    request: (message) => {
      sent.push(message);
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0", id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "conformance", version: "1" },
          },
        };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "METHOD_NOT_FOUND" } };
    },
  });
  transport.onNotification((message) => {
    notified.push(message);
  });
  return { transport, sent, notified };
}

describe("T-17 MCP conformance", () => {
  test("① 版本/能力/initialized 顺序与请求 id 单调递增", async () => {
    const h = server();
    const protocol = await createMcpProtocol(h.transport);
    expect(h.sent[0]?.method).toBe("initialize");
    expect(h.sent[0]?.params).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
    expect(h.notified.map((item) => item.method)).toEqual(["notifications/initialized"]);
    await expect(protocol.request("tools/call", { name: "missing" })).rejects.toThrow("METHOD_NOT_FOUND");
    const ids = h.sent.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    protocol.dispose();
  });

  test("② 服务器请求的错误码符合 JSON-RPC（-32601 未知方法）", async () => {
    const h = server();
    const protocol = await createMcpProtocol(h.transport);
    const responses: McpJsonRpcResponse[] = [];
    h.transport.setRespond((response) => {
      responses.push(response);
    });
    await h.transport.emitRequest({ jsonrpc: "2.0", id: 42, method: "sampling/createMessage" });
    expect(responses[0]).toMatchObject({ id: 42, error: { code: -32601 } });
    protocol.dispose();
  });

  test("③ 分页游标单调推进，无 cursor 时终止", async () => {
    const cursors: Array<string | undefined> = [];
    const items = await paginate({
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        if (cursor === undefined) return { items: [1], nextCursor: "c1" };
        if (cursor === "c1") return { items: [2], nextCursor: "c2" };
        return { items: [3] };
      },
    });
    expect(items).toEqual([1, 2, 3]);
    expect(cursors).toEqual([undefined, "c1", "c2"]);
  });

  test("④ 二进制资源无 sink 时失败关闭，绝不进入模型 content", async () => {
    await expect(projectMcpResult({ content: [{ type: "image", data: "QUJD" }] })).rejects.toThrow("MCP_RESOURCE_SINK_REQUIRED");
  });
});
