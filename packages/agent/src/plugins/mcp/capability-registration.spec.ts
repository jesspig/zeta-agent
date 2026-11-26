import { describe, expect, test } from "bun:test";
import { createContext } from "@zeta-agent/framework";
import {
  createEgressPolicy,
  createExecutionBackend,
  type Capabilities,
  type ExecutionBackend,
} from "@zeta-agent/security";
import { createAgent, type PluginApiSurface } from "../../facade";
import { installMcpPlugin, type McpResultSink } from "./index";
import type { McpJsonRpcRequest, McpJsonRpcResponse } from "./client";
import { createInMemoryMcpTransport } from "./transport";
import { MCP_PROTOCOL_VERSION } from "./protocol";

const SERVER = { name: "srv", transport: "stdio" as const, command: "fake" };
const CAPS: Capabilities = {
  isolation: "active", seccomp: "active", fsConfinement: "active",
  auditSink: "active", egressDefaultDeny: "active",
};

interface SetupOptions {
  readonly capabilities: Record<string, unknown>;
  readonly roots?: readonly { readonly uri: string; readonly name?: string }[];
  readonly resultSink?: McpResultSink;
  readonly binaryResource?: boolean;
}

function setup(options: SetupOptions) {
  const seen: McpJsonRpcRequest[] = [];
  const dispatched: McpJsonRpcResponse[] = [];
  const transport = createInMemoryMcpTransport({
    request: (message) => {
      seen.push(message);
      const result = (value: unknown): McpJsonRpcResponse => ({ jsonrpc: "2.0", id: message.id, result: value });
      if (message.method === "initialize") {
        return result({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: options.capabilities,
          serverInfo: { name: "fake", version: "1" },
        });
      }
      if (message.method === "tools/list") {
        return result({ tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] });
      }
      if (message.method === "prompts/list") {
        return result({ prompts: [{ name: "greet", description: "greeting", inputSchema: { type: "object", properties: { who: { type: "string" } } } }] });
      }
      if (message.method === "prompts/get") {
        return result({ messages: [{ role: "user", content: [{ type: "text", text: "HELLO PROMPT" }] }] });
      }
      if (message.method === "resources/list") {
        return result({ resources: [{ uri: "file:///a.bin", name: "a" }] });
      }
      if (message.method === "resources/read") {
        return result(options.binaryResource === true
          ? { contents: [{ uri: "file:///a.bin", mimeType: "image/png", blob: "QUJD" }] }
          : { contents: [{ uri: "file:///a.bin", mimeType: "text/plain", text: "RESOURCE TEXT" }] });
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NO" } };
    },
  });
  transport.setRespond((response) => {
    dispatched.push(response);
  });
  const backend: ExecutionBackend = createExecutionBackend({
    name: "test",
    capabilities: CAPS,
    executor: () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
  });
  const ctx = createContext();
  const agent = createAgent({
    includeBuiltins: false,
    coreContext: ctx,
    egressPolicy: createEgressPolicy(),
    streamFn: async function* () {
      yield "done";
    },
  });
  const registered = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const api = new Proxy(agent.api, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => {
          registered.set(tool.name, tool.execute);
          return target.registerTool(tool as never);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PluginApiSurface;
  const handle = installMcpPlugin({
    api,
    ctx,
    backend,
    transportFactory: () => transport,
    servers: [SERVER],
    ...(options.roots === undefined ? {} : { roots: options.roots }),
    ...(options.resultSink === undefined ? {} : { resultSink: options.resultSink }),
  });
  return { agent, handle, seen, dispatched, transport, registered };
}

describe("T-19 MCP capability 门控注册", () => {
  test("①  advertised tools/prompts/resources + roots 全部按能力注册并可达", async () => {
    const roots = [{ uri: "file:///workspace", name: "workspace" }];
    const h = setup({
      capabilities: { tools: {}, prompts: {}, resources: {} },
      roots,
    });
    await h.handle.ready;
    const snapshot = h.handle.snapshot();
    expect(snapshot.toolNames).toEqual([
      "mcp__srv__echo", "mcp__srv__prompt__greet", "mcp__srv__resource__0",
    ]);
    expect(snapshot.promptNames).toEqual(["mcp__srv__prompt__greet"]);
    expect(snapshot.resourceUris).toEqual(["file:///a.bin"]);
    expect(snapshot.rootsRegistered).toBe(1);
    expect(h.seen[0]?.params?.capabilities).toEqual({ roots: { listChanged: false } });

    expect(await h.registered.get("mcp__srv__prompt__greet")?.({ who: "x" })).toMatchObject({
      content: "HELLO PROMPT",
    });
    expect(await h.registered.get("mcp__srv__resource__0")?.({})).toMatchObject({
      content: "RESOURCE TEXT",
    });

    await h.transport.emitRequest({
      jsonrpc: "2.0", id: 42, method: "roots/list", params: {},
    });
    expect(h.dispatched.at(-1)).toEqual({
      jsonrpc: "2.0", id: 42, result: { roots },
    });
    await h.handle.dispose();
  });

  test("② 未声明的能力不注册、不调用；无 roots 不声明客户端能力", async () => {
    const h = setup({ capabilities: { tools: {} } });
    await h.handle.ready;
    const snapshot = h.handle.snapshot();
    expect(snapshot.toolNames).toEqual(["mcp__srv__echo"]);
    expect(snapshot.promptNames).toEqual([]);
    expect(snapshot.resourceUris).toEqual([]);
    expect(snapshot.rootsRegistered).toBe(0);
    expect(h.seen.map((message) => message.method)).not.toContain("prompts/list");
    expect(h.seen.map((message) => message.method)).not.toContain("resources/list");
    expect(h.seen[0]?.params?.capabilities).toEqual({});
    await h.handle.dispose();
  });

  test("③ 二进制资源无 sink 时执行失败关闭；有 sink 时只留文本与引用", async () => {
    const withoutSink = setup({ capabilities: { resources: {} }, binaryResource: true });
    await withoutSink.handle.ready;
    await expect(withoutSink.registered.get("mcp__srv__resource__0")?.({}))
      .rejects.toThrow("MCP_RESOURCE_SINK_REQUIRED");
    await withoutSink.handle.dispose();

    const saved: string[] = [];
    const withSink = setup({
      capabilities: { resources: {} },
      binaryResource: true,
      resultSink: {
        saveResource: (uri) => {
          saved.push(uri);
          return `mcp-resource://${uri}`;
        },
      },
    });
    await withSink.handle.ready;
    const projected = await withSink.registered.get("mcp__srv__resource__0")?.({}) as {
      content: string;
      details?: { resources: readonly { ref: string }[] };
    };
    expect(projected.content).not.toContain("QUJD");
    expect(projected.content).toContain("resource=mcp-resource://file:///a.bin");
    expect(saved).toEqual(["file:///a.bin"]);
    await withSink.handle.dispose();
  });
});
