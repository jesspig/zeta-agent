import { describe, expect, test } from "bun:test";
import { createAuditSink } from "@zeta-agent/security";
import { createAgent, type AgentEvent, type AgentStreamChunk } from "./facade";
import { createDurableEffects } from "./plugins/effects/durable";
import { createPermissionGate } from "./plugins/permissions/guard";
import type { ApprovalChannel } from "./plugins/permissions/approval";
import type { PermissionPolicy } from "./plugins/permissions/policy";

describe("T-08 facade unified pipeline wiring", () => {
  test("runTool no longer bypasses the permission path", async () => {
    const gate = createPermissionGate();
    let executed = 0;
    const agent = createAgent({ includeBuiltins: false, permissionGate: gate });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "ok";
      },
    } as never);
    const result = await agent.runTool({
      name: "probe",
      execute: () => {
        executed += 1;
        return "side-channel";
      },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : "").toContain("PERMISSION_DENIED");
    expect(executed).toBe(0);
  });

  test("ASK goes through four-state approval with request/reply ids", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
    gate.addBeforeToolCall((_context, next) => next({ behavior: "ASK", reason: "confirm" }));
    const seen: Array<{ requestId: string; replyId: string }> = [];
    const approvalChannel: ApprovalChannel = {
      async request(req) {
        seen.push({ requestId: req.requestId, replyId: "reply-1" });
        return { requestId: req.requestId, replyId: "reply-1", state: "allowed-once" };
      },
    };
    let turn = 0;
    let executed = 0;
    const agent = createAgent({
      includeBuiltins: false,
      permissionGate: gate,
      approvalChannel,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" } as never;
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "approved";
      },
    } as never);
    const messages = await agent.prompt("go");
    expect(executed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBeTruthy();
    expect(messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  test("end events carry tool name, args and duration from the pipeline", async () => {
    let turn = 0;
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "probe", arguments: '{"value":7}' } as never;
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [{ name: "value", type: "number", description: "n" }],
      execute: () => ({ ok: true, value: 7 }),
    } as never);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => void events.push(event));
    await agent.prompt("go");
    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end !== undefined && end.type === "tool_execution_end" ? end.toolName : "").toBe("probe");
    expect(end !== undefined && end.type === "tool_execution_end" ? end.args : undefined).toEqual({ value: 7 });
    expect(typeof (end !== undefined && end.type === "tool_execution_end" ? end.durationMs : undefined)).toBe("number");
  });

  test("permission policy deny blocks execution through the pipeline", async () => {
    const policy: PermissionPolicy = {
      kind: "restrict",
      of: [{ kind: "rule", rule: { effect: "DENY", stage: "plan", tool: "probe", reason: "policy-block" } }],
    };
    let turn = 0;
    let executed = 0;
    const agent = createAgent({
      includeBuiltins: false,
      permissionStage: "plan",
      permissionPolicy: policy,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" } as never;
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "ok";
      },
    } as never);
    await agent.prompt("go");
    expect(executed).toBe(0);
  });
});

type AgentConfig = NonNullable<Parameters<typeof createAgent>[0]>;

function activeBackend(): NonNullable<AgentConfig["securityBackend"]> {
  return {
    name: "t08-active-backend",
    capabilities: () => ({
      isolation: "active",
      seccomp: "active",
      fsConfinement: "active",
      auditSink: "active",
      egressDefaultDeny: "active",
    }),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
    dispose: () => {},
  };
}

function toolCallAgent(args: string, options: Partial<AgentConfig> = {}): ReturnType<typeof createAgent> {
  let turn = 0;
  return createAgent({
    includeBuiltins: false,
    emissionPolicy: "direct",
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn === 1) yield { type: "tool_call", id: "c1", name: "probe", arguments: args } as never;
      else yield "done";
    },
    ...options,
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1000 && !predicate(); index += 1) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

describe("T-08 real schemas and rejection audit", () => {
  test("provider schemas project real builtin/plugin definitions instead of a hardcoded empty list", () => {
    const builtinSchema = createAgent().providerToolSchemas().find((item) => item.name === "read");
    expect(builtinSchema?.description).toBeTruthy();
    expect(builtinSchema?.parameters).toEqual([
      { name: "path", type: "string", description: "要读取的文件绝对路径", required: true },
    ]);

    const agent = createAgent({ includeBuiltins: false });
    agent.api.registerTool({
      name: "search",
      description: "search docs",
      parameters: [{ name: "query", type: "string", description: "keywords", required: true }],
      execute: () => ({ ok: true }),
    } as never);
    expect(agent.providerToolSchemas()).toEqual([
      {
        name: "search",
        description: "search docs",
        parameters: [{ name: "query", type: "string", description: "keywords", required: true }],
      },
    ]);
  });

  test("missing, wrong-type and extra-field calls are rejected before execute and audited", async () => {
    for (const item of [
      { args: "{}", reason: "TOOL_INPUT_REQUIRED" },
      { args: '{"query":7}', reason: "TOOL_INPUT_TYPE" },
      { args: '{"query":"q","leak":true}', reason: "TOOL_INPUT_EXTRA_FIELD" },
    ]) {
      const sink = createAuditSink();
      let executed = 0;
      const agent = toolCallAgent(item.args, { auditSink: sink });
      agent.api.registerTool({
        name: "probe",
        description: "probe",
        parameters: [{ name: "query", type: "string", description: "keywords", required: true }],
        execute: () => {
          executed += 1;
          return "should-not-run";
        },
      } as never);
      const messages = await agent.prompt("go");
      expect(executed).toBe(0);
      const toolResult = messages.find((message) => message.role === "toolResult");
      expect(JSON.stringify(toolResult?.content)).toContain(item.reason);
      expect(sink.entries.some((entry) => entry.record.decision === "TOOL_INPUT_REJECTED")).toBe(true);
    }
  });
});

describe("T-08 runTool/model-tool parity and lease ownership", () => {
  test("runTool and model tool share hooks and audit but runTool emits no events or messages", async () => {
    const sink = createAuditSink();
    const hooks: string[] = [];
    const events: AgentEvent[] = [];
    let turn = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      auditSink: sink,
      securityBackend: activeBackend(),
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) yield { type: "tool_call", id: "c1", name: "model", arguments: "{}" } as never;
        else yield "done";
      },
    });
    agent.api.registerTool({ name: "model", description: "model tool", execute: () => "model-ok" } as never);
    agent.api.addBeforeToolCall(() => void hooks.push("before"));
    agent.api.addAfterToolCall(() => void hooks.push("after"));
    agent.subscribe((event) => void events.push(event));

    await agent.prompt("go");
    expect(hooks).toEqual(["before", "after"]);
    const modelToolEvents = events.filter((event) => event.type.startsWith("tool_execution")).length;
    const messageCount = agent.state.messages.length;

    const nested = await agent.runTool({ name: "nested", execute: () => "nested-ok" });
    expect(nested.ok).toBe(true);
    expect(hooks).toEqual(["before", "after", "before", "after"]);
    expect(events.filter((event) => event.type.startsWith("tool_execution")).length).toBe(modelToolEvents);
    expect(agent.state.messages).toHaveLength(messageCount);
    expect(sink.entries.filter((entry) => entry.record.decision === "TOOL_EXECUTED")).toHaveLength(2);
  });

  test("runTool shares durable effects and quota path with model tools", async () => {
    const dispatched: string[] = [];
    const durableEffects = createDurableEffects(async (intent) => {
      const payload = intent.payload as { readonly tool: string };
      dispatched.push(payload.tool);
      return { ok: true, value: "dispatched" };
    });
    const agent = createAgent({
      includeBuiltins: false,
      emissionTools: ["emit"],
      securityBackend: activeBackend(),
      durableEffects,
    });
    const result = await agent.runTool({ name: "emit", execute: () => "direct" });
    expect(result.ok).toBe(true);
    expect(dispatched).toEqual(["emit"]);
    const receipt = agent.emissionReceipts().find((item) => item.kind === "emit");
    expect(receipt?.ok).toBe(true);
  });

  test("waitForIdle waits for the tool lease and dispose cancels it without a hanging execution", async () => {
    let started = false;
    let turn = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) yield { type: "tool_call", id: "c1", name: "slow", arguments: "{}" } as never;
        else yield "done";
      },
    });
    agent.api.registerTool({
      name: "slow",
      description: "slow",
      execute: (_args: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          started = true;
          signal?.addEventListener("abort", () => reject(new Error("ABORTED")));
        }),
    } as never);
    const running = agent.prompt("go");
    await waitUntil(() => started);
    let idle = false;
    const waiting = agent.waitForIdle().then(() => {
      idle = true;
    });
    await Bun.sleep(5);
    expect(idle).toBe(false);
    await agent.dispose();
    await waiting;
    await running;
    expect(idle).toBe(true);
  });

  test("timeout confirms cooperative cancellation and returns unknown for reconciliation otherwise", async () => {
    const cooperative: string[] = [];
    let turn = 0;
    const cooperating = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      toolTimeoutMs: 5,
      toolTimeoutConfirmationMs: 100,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) yield { type: "tool_call", id: "c1", name: "coop", arguments: "{}" } as never;
        else yield "done";
      },
    });
    cooperating.api.registerTool({
      name: "coop",
      description: "coop",
      execute: (_args: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            cooperative.push("cancelled");
            reject(new Error("ABORTED"));
          });
        }),
    } as never);
    const messages = await cooperating.prompt("go");
    expect(cooperative).toEqual(["cancelled"]);
    expect(JSON.stringify(messages.find((message) => message.role === "toolResult")?.content)).toContain("TOOL_TIMEOUT");

    const stuck = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      securityBackend: activeBackend(),
      toolTimeoutMs: 5,
      toolTimeoutConfirmationMs: 5,
    });
    const result = await stuck.runTool({ name: "stuck", execute: () => new Promise<never>(() => {}) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("TOOL_TIMEOUT_UNKNOWN");
      expect(result.reconciliation).toBe(true);
    }
  });
});
