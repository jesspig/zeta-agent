import { describe, expect, test } from "bun:test";
import { createAgent, type AgentEvent, type AgentStreamChunk } from "./facade";
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
