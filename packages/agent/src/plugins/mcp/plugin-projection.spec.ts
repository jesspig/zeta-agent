import { describe, expect, test } from "bun:test";
import { createContext } from "@zeta-agent/framework";
import {
  createEgressPolicy,
  createExecutionBackend,
  type Capabilities,
  type ExecutionBackend,
} from "@zeta-agent/security";
import { createAgent, type AgentMessage, type AgentStreamChunk, type AgentStreamRequest } from "../../facade";
import { installMcpPlugin, parametersFromInputSchema } from "./index";
import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse, McpTransport } from "./client";
import { MCP_PROTOCOL_VERSION } from "./protocol";
import type { McpResultSink } from "./result-projection";

const SERVER = { name: "srv", transport: "stdio" as const, command: "fake" };
const CAPS: Capabilities = {
  isolation: "active", seccomp: "active", fsConfinement: "active",
  auditSink: "active", egressDefaultDeny: "active",
};

interface SetupOptions {
  readonly sink?: McpResultSink;
  readonly toolResult?: (name: string, args: Record<string, unknown>) => unknown;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly onRequest?: (request: AgentStreamRequest) => void;
}

function setup(options: SetupOptions = {}) {
  const listeners = new Set<(message: McpJsonRpcNotification) => void | Promise<void>>();
  const backend: ExecutionBackend = createExecutionBackend({
    name: "test",
    capabilities: CAPS,
    executor: () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
  });
  const transport: McpTransport = {
    async request(message: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0", id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fake", version: "1" },
          },
        };
      }
      if (message.method === "tools/list") {
        return {
          jsonrpc: "2.0", id: message.id,
          result: {
            tools: [{
              name: "find",
              description: "search",
              inputSchema: options.inputSchema ?? {
                type: "object",
                properties: {
                  q: { type: "string", description: "query" },
                  limit: { type: "number", description: "max" },
                },
                required: ["q"],
              },
              outputSchema: options.outputSchema ?? { type: "object", properties: { rows: { type: "array" } } },
              annotations: { readOnlyHint: true },
            }],
          },
        };
      }
      if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments: Record<string, unknown> };
        const result = options.toolResult?.(params.name, params.arguments) ?? {
          content: [
            { type: "text", text: "MODEL-VISIBLE" },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
          structuredContent: { rows: [1, 2], secret: "PROGRAM-ONLY" },
        };
        return { jsonrpc: "2.0", id: message.id, result };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NO" } };
    },
    async notify() {},
    onNotification(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRequest() { return () => {}; },
    async respond() {},
    dispose() {},
  };
  const ctx = createContext();
  let turn = 0;
  const agent = createAgent({
    includeBuiltins: false,
    coreContext: ctx,
    egressPolicy: createEgressPolicy(),
    streamFn: async function* (request: AgentStreamRequest): AsyncIterable<AgentStreamChunk> {
      options.onRequest?.(request);
      turn += 1;
      if (turn === 1) {
        yield { type: "tool_call", id: "c1", name: "mcp__srv__find", arguments: JSON.stringify({ q: "x" }) };
        return;
      }
      yield "done";
    },
  });
  const handle = installMcpPlugin({
    api: agent.api,
    ctx,
    backend,
    transportFactory: () => transport,
    servers: [SERVER],
    ...(options.sink === undefined ? {} : { resultSink: options.sink }),
  });
  return { agent, handle };
}

describe("T-17 插件集成：schema 保真与双结果投影", () => {
  test("① inputSchema 投影为 provider 参数，required 与描述不丢失", async () => {
    const parameters = parametersFromInputSchema({
      type: "object",
      properties: {
        q: { type: "string", description: "query" },
        limit: { type: "number", description: "max" },
      },
      required: ["q"],
    });
    expect(parameters).toEqual([
      { name: "q", type: "string", description: "query", required: true },
      { name: "limit", type: "number", description: "max" },
    ]);
  });

  test("② 模型 content 只含文本，structuredContent 与二进制由程序侧消费", async () => {
    const saved: string[] = [];
    const { agent, handle } = setup({
      sink: {
        saveResource: (uri) => {
          saved.push(uri);
          return "mcp-resource://srv/image.png";
        },
      },
    });
    await handle.ready;
    const programResults: unknown[] = [];
    agent.api.addAfterToolCall((event) => {
      programResults.push((event as { result?: unknown }).result);
    });
    const messages = await agent.prompt("go");
    const result = messages.find((message) => message.role === "toolResult") as AgentMessage | undefined;
    expect(result?.content).toContain("MODEL-VISIBLE");
    expect(result?.content).not.toContain("PROGRAM-ONLY");
    expect(result?.content).not.toContain("QUJD");
    expect(saved).toEqual(["mcp:image:0"]);
    const raw = programResults[0] as { structuredContent?: unknown };
    expect(raw?.structuredContent).toEqual({ rows: [1, 2], secret: "PROGRAM-ONLY" });
    await handle.dispose();
  });

  test("③ agent-scoped 注册：dispose 后工具与 schema 一并撤销", async () => {
    const { agent, handle } = setup();
    await handle.ready;
    expect(agent.toolNames).toContain("mcp__srv__find");
    await handle.dispose();
    expect(agent.toolNames).not.toContain("mcp__srv__find");
    expect(agent.providerToolSchemas().some((item) => item.name === "mcp__srv__find")).toBe(false);
  });

  test("④ 生产 provider 请求保留完整嵌套 input/outputSchema（不平铺、不丢弃）", async () => {
    const inputSchema = {
      type: "object",
      properties: {
        q: { type: "string", description: "query" },
        nested: {
          type: "object",
          description: "nested options",
          properties: {
            tags: { type: "array", items: { type: "string" }, description: "tag list" },
            depth: { type: "integer", description: "depth" },
          },
          required: ["tags"],
        },
      },
      required: ["q", "nested"],
    };
    const outputSchema = { type: "object", properties: { rows: { type: "array", items: { type: "object" } } }, required: ["rows"] };
    let requestTools: AgentStreamRequest["tools"];
    const { agent, handle } = setup({
      inputSchema,
      outputSchema,
      onRequest: (request) => {
        requestTools = request.tools;
      },
    });
    await handle.ready;
    await agent.prompt("go");
    const tool = requestTools?.find((item) => item.name === "mcp__srv__find");
    expect(tool?.inputSchema).toEqual(inputSchema);
    expect(tool?.outputSchema).toEqual(outputSchema);
    // 嵌套项也进入扁平参数表，而不是被丢弃。
    expect(tool?.parameters.map((item) => item.name)).toEqual(["q", "nested"]);
    expect(tool?.parameters.find((item) => item.name === "nested")?.type).toBe("object");
    await handle.dispose();
  });
});
