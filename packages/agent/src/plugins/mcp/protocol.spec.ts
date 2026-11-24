import { describe, expect, test } from "bun:test";
import type { Disposer } from "@zeta-agent/framework";
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpTransport,
} from "./client";
import {
  createMcpProtocol,
  MCP_PROTOCOL_VERSION,
} from "./protocol";

interface ScriptedTransport extends McpTransport {
  readonly sent: McpJsonRpcRequest[];
  readonly notified: McpJsonRpcNotification[];
  readonly requests: Array<(message: McpJsonRpcRequest) => void | Promise<void>>;
  respond(message: McpJsonRpcResponse): void;
  pushResponse(response: McpJsonRpcResponse): void;
  incoming(message: McpJsonRpcRequest): Promise<void>;
}

function scriptedTransport(
  handshake: (message: McpJsonRpcRequest) => McpJsonRpcResponse
): ScriptedTransport {
  const sent: McpJsonRpcRequest[] = [];
  const notified: McpJsonRpcNotification[] = [];
  const requests: Array<(message: McpJsonRpcRequest) => void | Promise<void>> = [];
  const pending = new Map<number, (response: McpJsonRpcResponse) => void>();
  const responses: McpJsonRpcResponse[] = [];
  let disposed = 0;
  const transport: ScriptedTransport = {
    sent,
    notified,
    requests,
    async request(message) {
      sent.push(message);
      if (message.method === "initialize") return handshake(message);
      const queued = responses.shift();
      if (queued !== undefined) return queued;
      return new Promise<McpJsonRpcResponse>((resolve) => pending.set(message.id, resolve));
    },
    async notify(message) {
      notified.push(message);
    },
    onNotification() {
      return () => {};
    },
    onRequest(listener) {
      requests.push(listener);
      return () => {
        const index = requests.indexOf(listener);
        if (index >= 0) requests.splice(index, 1);
      };
    },
    respond(message) {
      (transport as { _responded?: McpJsonRpcResponse[] })._responded ??= [];
      (transport as { _responded?: McpJsonRpcResponse[] })._responded!.push(message);
    },
    pushResponse(response) {
      const resolve = pending.get(response.id);
      if (resolve !== undefined) {
        pending.delete(response.id);
        resolve(response);
      } else {
        responses.push(response);
      }
    },
    async incoming(message) {
      for (const listener of [...requests]) await listener(message);
    },
    dispose() {
      disposed += 1;
    },
  };
  Object.defineProperty(transport, "responded", {
    get: () => (transport as { _responded?: McpJsonRpcResponse[] })._responded ?? [],
  });
  Object.defineProperty(transport, "disposed", { get: () => disposed });
  return transport;
}

const OK_HANDSHAKE = (message: McpJsonRpcRequest): McpJsonRpcResponse => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true }, resources: {} },
    serverInfo: { name: "fake", version: "1.0.0" },
  },
});

describe("T-17 MCP 协议握手与取消", () => {
  test("① initialize 携带版本/能力/clientInfo，随后发送 initialized 通知", async () => {
    const transport = scriptedTransport(OK_HANDSHAKE);
    const protocol = await createMcpProtocol(transport, {
      clientInfo: { name: "zeta-test", version: "2.0" },
      capabilities: { roots: { listChanged: true }, sampling: {} },
    });

    expect(protocol.initialized).toBe(true);
    expect(protocol.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(protocol.serverInfo).toEqual({ name: "fake", version: "1.0.0" });
    expect(protocol.serverCapabilities).toEqual({ tools: { listChanged: true }, resources: {} });
    expect(transport.sent[0]?.method).toBe("initialize");
    expect(transport.sent[0]?.params).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: "zeta-test", version: "2.0" },
    });
    expect(transport.notified).toEqual([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
  });

  test("② 不支持的协议版本或畸形 capabilities 直接失败", async () => {
    const badVersion = scriptedTransport((message) => ({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "1999-01-01",
        capabilities: {},
        serverInfo: { name: "old", version: "1" },
      },
    }));
    await expect(createMcpProtocol(badVersion)).rejects.toThrow("MCP_UNSUPPORTED_PROTOCOL_VERSION");
    expect(badVersion.notified).toHaveLength(0);

    const badCapabilities = scriptedTransport((message) => ({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: [], serverInfo: { name: "x", version: "1" } },
    }));
    await expect(createMcpProtocol(badCapabilities)).rejects.toThrow("MCP_INVALID_INIT_RESULT");
  });

  test("③ 超时先发 cancelled 通知再拒绝，迟到响应被丢弃", async () => {
    const transport = scriptedTransport(OK_HANDSHAKE);
    const protocol = await createMcpProtocol(transport);
    const pending = protocol.request("tools/list", {}, { timeoutMs: 5 });
    await expect(pending).rejects.toThrow("MCP_TIMEOUT");
    expect(transport.notified.at(-1)).toMatchObject({
      method: "notifications/cancelled",
      params: { reason: "MCP_TIMEOUT" },
    });
    transport.pushResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });

  test("④ AbortSignal 取消在途请求；迟到结果不提交且可重新请求", async () => {
    const transport = scriptedTransport(OK_HANDSHAKE);
    const protocol = await createMcpProtocol(transport);
    const controller = new AbortController();
    const pending = protocol.request("tools/call", { name: "x" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("MCP_ABORTED");
    expect(transport.notified.at(-1)).toMatchObject({
      method: "notifications/cancelled",
      params: { reason: "MCP_ABORTED" },
    });
    transport.pushResponse({ jsonrpc: "2.0", id: 2, result: { content: [] } });

    const retry = protocol.request("ping");
    transport.pushResponse({ jsonrpc: "2.0", id: 3, result: {} });
    await expect(retry).resolves.toEqual({});
  });

  test("⑤ server→client 请求：roots/list 应答，未知方法返回 -32601", async () => {
    const transport = scriptedTransport(OK_HANDSHAKE);
    const protocol = await createMcpProtocol(transport);
    const off = protocol.onRequest("roots/list", () => ({
      roots: [{ uri: "file:///workspace" }],
    }));
    await transport.incoming({ jsonrpc: "2.0", id: 91, method: "roots/list" });
    expect((transport as unknown as { responded: McpJsonRpcResponse[] }).responded.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 91,
      result: { roots: [{ uri: "file:///workspace" }] },
    });

    await transport.incoming({ jsonrpc: "2.0", id: 92, method: "unknown" });
    expect((transport as unknown as { responded: McpJsonRpcResponse[] }).responded.at(-1)).toMatchObject({
      id: 92,
      error: { code: -32601 },
    });
    off();
    await transport.incoming({ jsonrpc: "2.0", id: 93, method: "roots/list" });
    expect((transport as unknown as { responded: McpJsonRpcResponse[] }).responded.at(-1)).toMatchObject({
      id: 93,
      error: { code: -32601 },
    });
    protocol.dispose();
    expect((transport as unknown as { disposed: number }).disposed).toBe(1);
  });
});
