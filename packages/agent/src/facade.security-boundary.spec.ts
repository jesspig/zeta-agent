import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities, EgressPolicy, ExecutionBackend } from "@zeta-agent/security";
import { createEgressPolicy } from "@zeta-agent/security";
import { createAgent, type AgentStreamChunk, type ConfirmChannel, type ConfirmRequest } from "./facade";
import { createPermissionGate, type PermissionGate } from "./plugins/permissions/guard";

function activeCapabilities(): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  };
}

function recordingBackend(
  calls: string[][],
  capabilities: Capabilities = activeCapabilities()
): ExecutionBackend {
  return {
    name: "boundary-recording-backend",
    capabilities: () => ({ ...capabilities }),
    run: async (command) => {
      calls.push([...command.argv]);
      return { exitCode: 0, stdout: "", stderr: "", isolated: null };
    },
    dispose: () => {},
  };
}

interface ToolCase {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function toolHarness(options: {
  readonly calls: readonly ToolCase[];
  readonly gate?: PermissionGate;
  readonly confirmChannel?: ConfirmChannel;
  readonly egressPolicy?: EgressPolicy;
  readonly emissionTools?: readonly string[];
}) {
  let turn = 0;
  const executions: string[] = [];
  const agent = createAgent({
    includeBuiltins: false,
    allowTextToolMarkers: true,
    ...(options.gate !== undefined ? { permissionGate: options.gate } : {}),
    ...(options.confirmChannel !== undefined ? { confirmChannel: options.confirmChannel } : {}),
    ...(options.egressPolicy !== undefined ? { egressPolicy: options.egressPolicy } : {}),
    ...(options.emissionTools !== undefined ? { emissionTools: options.emissionTools } : {}),
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn === 1) {
        for (const call of options.calls) yield `@@TOOL:${call.name}:${JSON.stringify(call.args)}@@`;
        return;
      }
      yield "done";
    },
  });
  for (const name of new Set(options.calls.map((call) => call.name))) {
    agent.api.registerTool({
      name,
      description: name,
      parameters: [],
      execute: () => {
        executions.push(name);
        return "EXECUTED";
      },
    } as never);
  }
  return { agent, executions: () => [...executions] };
}

function firstToolResult(messages: readonly { readonly role: string; readonly content: unknown }[]): unknown {
  return messages.find((message) => message.role === "toolResult")?.content;
}

function askGate(reason = "need-approval"): PermissionGate {
  const gate = createPermissionGate();
  gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
  gate.addBeforeToolCall((_context, next) => next({ behavior: "ASK", reason }));
  return gate;
}

describe("A8/ASK：注入式确认通道", () => {
  test("ASK 未注入确认通道时维持 fail-closed，工具不执行", async () => {
    const { agent, executions } = toolHarness({
      calls: [{ name: "probe", args: {} }],
      gate: askGate(),
    });

    const messages = await agent.prompt("go");
    expect(executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("PERMISSION_DENIED");
  });

  test("ASK 注入通道且确认通过时放行，并记录确认请求", async () => {
    const seen: ConfirmRequest[] = [];
    const confirmChannel: ConfirmChannel = {
      confirm: async (request) => {
        seen.push(request);
        return true;
      },
    };
    const { agent, executions } = toolHarness({
      calls: [{ name: "probe", args: { value: 1 } }],
      gate: askGate(),
      confirmChannel,
    });

    await agent.prompt("go");
    expect(executions()).toEqual(["probe"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ stage: "plan", tool: "probe", reason: "need-approval" });
    expect(seen[0]?.args).toEqual({ value: 1 });
  });

  test("ASK 通道拒绝时仍 fail-closed", async () => {
    const confirmChannel: ConfirmChannel = { confirm: async () => false };
    const { agent, executions } = toolHarness({
      calls: [{ name: "probe", args: {} }],
      gate: askGate(),
      confirmChannel,
    });

    const messages = await agent.prompt("go");
    expect(executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("PERMISSION_DENIED");
  });

  test("DENY 即使注入通道且通道返回通过也始终拒绝", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
    gate.addBeforeToolCall((_context, next) => next({ behavior: "DENY", reason: "hard-deny" }));
    const confirmChannel: ConfirmChannel = { confirm: async () => true };
    const { agent, executions } = toolHarness({
      calls: [{ name: "probe", args: {} }],
      gate,
      confirmChannel,
    });

    const messages = await agent.prompt("go");
    expect(executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("hard-deny");
  });
});

describe("egress 默认拒绝覆盖所有路径", () => {
  test("默认策略下非发射工具携带外联 url 被拒绝，工具不执行", async () => {
    const { agent, executions } = toolHarness({
      calls: [{ name: "fetch", args: { url: "https://evil.test/x" } }],
    });

    const messages = await agent.prompt("go");
    expect(executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("EGRESS_DENIED");
  });

  test("非发射工具在 allow 策略内可外联，denyAlways 优先拒绝", async () => {
    const allowed = toolHarness({
      calls: [{ name: "fetch", args: { url: "https://allowed.test/x" } }],
      egressPolicy: createEgressPolicy({ allow: [{ host: "allowed.test", port: 443 }] }),
    });
    await allowed.agent.prompt("go");
    expect(allowed.executions()).toEqual(["fetch"]);

    const hardDenied = toolHarness({
      calls: [{ name: "fetch", args: { target: { host: "pinned.test", port: 443 } } }],
      egressPolicy: createEgressPolicy({
        allow: [{ host: "pinned.test", port: 443 }],
        denyAlways: [{ host: "pinned.test", port: 443 }],
      }),
    });
    const messages = await hardDenied.agent.prompt("go");
    expect(hardDenied.executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("EGRESS_DENIED");
  });

  test("默认策略下发射工具的外联同样被拒绝并写入失败回执", async () => {
    const { agent, executions } = toolHarness({
      calls: [{ name: "emit", args: { url: "https://sink.test/notify" } }],
      emissionTools: ["emit"],
    });

    const messages = await agent.prompt("go");
    expect(executions()).toEqual([]);
    expect(JSON.stringify(firstToolResult(messages))).toContain("EGRESS_DENIED");
    const failures = agent.emissionReceipts().filter((receipt) => !receipt.ok);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).toContain("EGRESS_DENIED");
  });
});

describe("A22-b：write/edit 经 ExecutionBackend，realpath 防逃逸保留", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-boundary-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function runBuiltin(
    name: string,
    args: Record<string, unknown>,
    backend: ExecutionBackend
  ): Promise<unknown> {
    const agent = createAgent({
      allowedDirectories: [root],
      securityBackend: backend,
      emissionPolicy: "direct",
      allowTextToolMarkers: true,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        yield `@@TOOL:${name}:${JSON.stringify(args)}@@`;
      },
    });
    const messages = await agent.prompt("go");
    return firstToolResult(messages);
  }

  test("write/edit 调用 backend.run 并在 realpath 校验后落盘", async () => {
    const calls: string[][] = [];
    const backend = recordingBackend(calls);
    const file = join(root, "a.txt");

    const writeResult = await runBuiltin("write", { path: file, content: "seed" }, backend);
    expect(JSON.stringify(writeResult)).toContain('"ok":true');
    expect(calls.some((argv) => argv[0] === "fs:write" && argv[1] === file)).toBe(true);

    const editResult = await runBuiltin("edit", { path: file, from: "seed", to: "next" }, backend);
    expect(JSON.stringify(editResult)).toContain('"ok":true');
    expect(calls.some((argv) => argv[0] === "fs:edit" && argv[1] === file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("next");
  });

  test("关键层降级时 write/edit 经后端失败关闭，文件不被改动", async () => {
    const backend = recordingBackend([], { ...activeCapabilities(), seccomp: "degraded" });
    const file = join(root, "b.txt");
    writeFileSync(file, "original", "utf8");

    const writeResult = await runBuiltin("write", { path: file, content: "tampered" }, backend);
    expect(JSON.stringify(writeResult)).toContain("CRITICAL_LAYER_DEGRADED");
    const editResult = await runBuiltin("edit", { path: file, from: "original", to: "tampered" }, backend);
    expect(JSON.stringify(editResult)).toContain("CRITICAL_LAYER_DEGRADED");
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("write/edit 仍拒绝允许目录之外的真实目标（realpath 防逃逸保留）", async () => {
    const calls: string[][] = [];
    const backend = recordingBackend(calls);
    const outside = join(root, "..", `zeta-boundary-out-${Date.now()}.txt`);

    const result = await runBuiltin("write", { path: outside, content: "escape" }, backend);
    expect(JSON.stringify(result)).toMatch(/CONFINEMENT|outside/i);
    expect(calls.some((argv) => argv[0] === "fs:write")).toBe(false);
  });

  test("facade.createProviderStreamFn 注入裸 fetch 且无 allow 仍失败关闭", async () => {
    let calls = 0;
    const bareFetch = (async () => {
      calls += 1;
      return new Response("data: [DONE]\n\n", { status: 200 });
    }) as unknown as typeof fetch;
    const agent = createAgent({ includeBuiltins: false });
    const stream = agent.createProviderStreamFn({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "k",
      baseUrl: "https://api.test/v1",
    }, bareFetch);
    await expect((async () => {
      for await (const _chunk of stream({ messages: [] })) void _chunk;
    })()).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    expect(calls).toBe(0);
  });
});
