import { describe, expect, test } from "bun:test";
import { createContext } from "@zeta-agent/framework";
import {
  createEgressPolicy,
  createExecutionBackend,
  type Capabilities,
  type EgressPolicy,
  type ExecutionBackend,
} from "@zeta-agent/security";
import { createAgent, type AgentMessage, type AgentStreamChunk } from "../../facade";
import { createPermissionGate, type PermissionGate } from "../permissions/guard";
import { installMcpPlugin } from "./index";
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpToolDescriptor,
  McpTransport,
} from "./client";
import type { McpServerConfig } from "./config";

const STDIO_SERVER: McpServerConfig = {
  name: "github",
  transport: "stdio",
  command: "fake-mcp-server",
};
const SSE_SERVER: McpServerConfig = {
  name: "remote",
  transport: "sse",
  url: "https://mcp.example.test/sse",
};

function activeCapabilities(): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  };
}

interface FakeServer {
  tools: McpToolDescriptor[];
  readonly calls: Array<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }>;
  disposed: number;
  readonly listeners: Set<(message: McpJsonRpcNotification) => void | Promise<void>>;
  emitChange(): Promise<void>;
}

function createFakeServer(tools: readonly McpToolDescriptor[]): FakeServer {
  const listeners = new Set<(message: McpJsonRpcNotification) => void | Promise<void>>();
  const calls: Array<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }> = [];
  return {
    tools: [...tools],
    calls,
    disposed: 0,
    listeners,
    async emitChange() {
      const notification: McpJsonRpcNotification = {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      };
      await Promise.all([...listeners].map((listener) => listener(notification)));
    },
  };
}

function createLoopbackTransport(fake: FakeServer): McpTransport {
  return {
    async request(message: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" } },
        };
      }
      if (message.method === "tools/list") {
        return { jsonrpc: "2.0", id: message.id, result: { tools: fake.tools } };
      }
      if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments: Record<string, unknown> };
        fake.calls.push({ name: params.name, args: params.arguments });
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "METHOD_NOT_FOUND" } };
    },
    async notify() {},
    onNotification(listener) {
      fake.listeners.add(listener);
      return () => {
        fake.listeners.delete(listener);
      };
    },
    onRequest() {
      return () => {};
    },
    async respond() {},
    dispose() {
      fake.disposed += 1;
    },
  };
}

interface HarnessOptions {
  readonly tools: readonly McpToolDescriptor[];
  readonly calls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  readonly servers?: readonly McpServerConfig[];
  readonly gate?: PermissionGate;
  readonly egressPolicy?: EgressPolicy;
  readonly capabilities?: Capabilities;
}

function setup(options: HarnessOptions) {
  const servers = options.servers ?? [STDIO_SERVER];
  const fake = createFakeServer(options.tools);
  const backendCalls: Array<{ readonly argv: readonly string[]; readonly realm?: string }> = [];
  const backend: ExecutionBackend = createExecutionBackend({
    name: "mcp-test-backend",
    capabilities: options.capabilities ?? activeCapabilities(),
    executor: (command, runOptions) => {
      backendCalls.push({ argv: [...command.argv], realm: runOptions?.realm });
      return { exitCode: 0, stdout: "", stderr: "", isolated: null };
    },
  });
  const ctx = createContext();
  const notifyKeys: string[][] = [];
  const calls = options.calls ?? [];
  let turn = 0;
  const agent = createAgent({
    includeBuiltins: false,
    coreContext: ctx,
    ...(options.gate !== undefined ? { permissionGate: options.gate } : {}),
    ...(options.egressPolicy !== undefined ? { egressPolicy: options.egressPolicy } : {}),
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn === 1) {
        for (const [index, call] of calls.entries()) {
          yield { type: "tool_call", id: `c${index + 1}`, name: call.name, arguments: JSON.stringify(call.args) };
        }
        return;
      }
      yield "done";
    },
  });
  const handle = installMcpPlugin({
    api: agent.api,
    ctx,
    backend,
    transportFactory: () => createLoopbackTransport(fake),
    servers,
    ...(options.egressPolicy !== undefined ? { egressPolicy: options.egressPolicy } : {}),
    ...(options.gate !== undefined ? { permissionGate: options.gate } : {}),
    notify: async (keys) => {
      notifyKeys.push(keys.map((key) => key.symbol.description ?? key.name));
      await ctx.notify(keys);
    },
  });
  return { agent, ctx, handle, fake, backendCalls, notifyKeys, run: () => agent.prompt("go") };
}

function firstToolResult(messages: readonly AgentMessage[]): unknown {
  return messages.find((message) => message.role === "toolResult")?.content;
}

const READ_TOOL: McpToolDescriptor = {
  name: "get_repo",
  description: "read only",
  annotations: { readOnlyHint: true },
};
const EMIT_TOOL: McpToolDescriptor = {
  name: "create_issue",
  description: "external write",
  annotations: { readOnlyHint: false },
};
const READ_NAME = "mcp__github__get_repo";
const EMIT_NAME = "mcp__github__create_issue";

describe("T-04 MCP 插件", () => {
  test("① 工具注册与三段式命名，连接绑定 ExecutionBackend session", async () => {
    const h = setup({
      tools: [READ_TOOL, EMIT_TOOL],
      calls: [{ name: READ_NAME, args: { repo: "zeta" } }],
    });
    await h.handle.ready;

    expect(h.agent.toolNames).toContain(READ_NAME);
    expect(h.agent.toolNames).toContain(EMIT_NAME);
    expect(h.handle.snapshot().toolNames).toEqual([READ_NAME, EMIT_NAME]);
    // 未声明 readOnlyHint 的工具被划为发射类，交给 facade 的 withhold 路径。
    expect(h.handle.snapshot().emissionToolNames).toEqual([EMIT_NAME]);
    // stdio server 连接必须由 backend 会话绑定，realm 由 server 名派生。
    expect(h.backendCalls[0]?.realm).toBe("mcp:github");
    expect(h.backendCalls[0]?.argv[0]).toBe("mcp:session");

    const messages = await h.run();
    expect(h.fake.calls).toEqual([{ name: "get_repo", args: { repo: "zeta" } }]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("ok");
  });

  test("② tools/list_changed 触发 ctx.notify 并重激活，旧工具撤销、新工具注册", async () => {
    const h = setup({ tools: [READ_TOOL] });
    await h.handle.ready;
    expect(h.agent.toolNames).toContain(READ_NAME);

    const newTool: McpToolDescriptor = { name: "search_code", annotations: { readOnlyHint: true } };
    h.fake.tools = [newTool];
    await h.fake.emitChange();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(h.notifyKeys).toContainEqual(["@zeta-agent/mcp:servers"]);
    expect(h.agent.toolNames).not.toContain(READ_NAME);
    expect(h.agent.toolNames).toContain("mcp__github__search_code");
    expect(h.handle.snapshot().toolNames).toEqual(["mcp__github__search_code"]);
    // 重激活关闭旧连接并重新建立绑定会话。
    expect(h.fake.disposed).toBeGreaterThanOrEqual(1);
    expect(h.backendCalls.length).toBe(2);
  });

  test("③ 权限拒绝：DENY 经 permissionGate.authorize 生效，MCP 调用未发出", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: READ_NAME, stages: ["plan"] }]);
    gate.addBeforeToolCall((_context, next) => next({ behavior: "DENY", reason: "mcp-blocked" }));
    const h = setup({
      tools: [READ_TOOL],
      calls: [{ name: READ_NAME, args: {} }],
      gate,
    });
    await h.handle.ready;

    const messages = await h.run();
    expect(h.fake.calls).toHaveLength(0);
    expect(JSON.stringify(firstToolResult(messages))).toContain("mcp-blocked");
    expect(JSON.stringify(firstToolResult(messages))).toContain("PERMISSION_DENIED");
  });

  test("④ withhold：发射类 MCP 工具先 enqueue，commit 后经 durable 派发一次", async () => {
    const h = setup({
      tools: [EMIT_TOOL],
      calls: [
        { name: EMIT_NAME, args: { title: "hello" } },
        { name: "probe", args: {} },
      ],
    });
    await h.handle.ready;
    expect(h.agent.emissionReceipts()).toHaveLength(0);

    let duringBatch = -1;
    let receiptsDuringBatch = -1;
    h.agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => "PROBED",
    } as never);
    h.agent.api.addAfterToolCall((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "probe") {
        duringBatch = h.fake.calls.length;
        receiptsDuringBatch = h.agent.emissionReceipts().length;
      }
    });

    await h.run();
    // probe 的 after 钩子在 commit 前运行：此时 MCP 尚未被调用、也没有回执。
    expect(duringBatch).toBe(0);
    expect(receiptsDuringBatch).toBe(0);
    // commit 后真实 MCP 调用恰好一次，durable 回执恰好一条。
    expect(h.fake.calls).toEqual([{ name: "create_issue", args: { title: "hello" } }]);
    const receipts = h.agent.emissionReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe(EMIT_NAME);
    expect(receipts[0]?.ok).toBe(true);
  });

  test("⑤ egress 默认拒绝：工具参数外联被挡，网络型 server 未获 allow 不连接", async () => {
    const h = setup({
      tools: [READ_TOOL],
      calls: [{ name: READ_NAME, args: { url: "https://external.test/x" } }],
    });
    await h.handle.ready;
    const messages = await h.run();
    expect(h.fake.calls).toHaveLength(0);
    expect(JSON.stringify(firstToolResult(messages))).toContain("EGRESS_DENIED");

    const remote = setup({ tools: [READ_TOOL], servers: [SSE_SERVER] });
    await remote.handle.ready;
    expect(remote.handle.fiber.state.kind).toBe("FAILED");
    expect((remote.handle.fiber.state as { error?: unknown }).error).toMatchObject({
      message: expect.stringContaining("EGRESS_DENIED"),
    });
    expect(remote.backendCalls).toHaveLength(0);

    const allowed = setup({
      tools: [READ_TOOL],
      servers: [SSE_SERVER],
      egressPolicy: createEgressPolicy({ allow: [{ host: "mcp.example.test", port: 443 }] }),
    });
    await allowed.handle.ready;
    expect(allowed.handle.fiber.state.kind).toBe("ACTIVE");
  });

  test("⑥ 卸载清理：fiber/context 卸载时关闭连接并撤销注册工具", async () => {
    const h = setup({ tools: [READ_TOOL] });
    await h.handle.ready;
    expect(h.agent.toolNames).toContain(READ_NAME);

    await h.handle.dispose();
    expect(h.fake.disposed).toBe(1);
    expect(h.agent.toolNames).not.toContain(READ_NAME);

    const second = setup({ tools: [READ_TOOL] });
    await second.handle.ready;
    await second.ctx.dispose();
    expect(second.fake.disposed).toBe(1);
  });

  test("⑦ 后端能力降级失败关闭：不建立会话、不注册工具", async () => {
    const h = setup({
      tools: [READ_TOOL],
      capabilities: { ...activeCapabilities(), seccomp: "degraded" },
    });
    await h.handle.ready;
    expect(h.handle.fiber.state.kind).toBe("FAILED");
    expect(h.backendCalls).toHaveLength(0);
    expect(h.agent.toolNames).not.toContain(READ_NAME);
  });
});
