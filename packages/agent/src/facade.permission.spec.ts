import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentStreamChunk } from "./facade";
import { createAgent } from "./facade";
import { createPermissionGate, type PermissionGate } from "./plugins/permissions/guard";

interface Harness {
  readonly agent: ReturnType<typeof createAgent>;
  readonly events: AgentEvent[];
  readonly executions: () => number;
}

/** 每回合发一次 probe 工具调用；turns 用尽后发文本收束，避免自动续跑失控。 */
function gatedHarness(options: {
  readonly gate: PermissionGate;
  readonly stage?: string;
  readonly turns: number;
}): Harness {
  let turn = 0;
  let executions = 0;
  const agent = createAgent({
    includeBuiltins: false,
    allowTextToolMarkers: true,
    permissionGate: options.gate,
    ...(options.stage !== undefined ? { permissionStage: options.stage } : {}),
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn <= options.turns) {
        yield "@@TOOL:probe:{}@@";
        return;
      }
      yield "done";
    },
  });
  agent.api.registerTool({
    name: "probe",
    description: "probe tool",
    parameters: [],
    execute: () => {
      executions += 1;
      return "EXECUTED";
    },
  } as never);
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });
  return { agent, events, executions: () => executions };
}

function endResults(events: readonly AgentEvent[]): Array<{ readonly result: unknown; readonly isError: boolean }> {
  return events.flatMap((event) =>
    event.type === "tool_execution_end"
      ? [{ result: event.result, isError: event.isError }]
      : []
  );
}

describe("T-05 权限门禁在 createAgent 工具执行路径强制生效", () => {
  test("① 注入 gate 后 DENY 的工具不被执行，产生 isError 结果与明确 reason", async () => {
    const gate = createPermissionGate();
    const { agent, events, executions } = gatedHarness({ gate, turns: 1 });
    await agent.prompt("go");

    expect(executions()).toBe(0);
    const ends = endResults(events);
    expect(ends.length).toBe(1);
    expect(ends[0]?.isError).toBe(true);
    const serialized = JSON.stringify(ends[0]?.result);
    expect(serialized).toContain("PERMISSION_DENIED");
    expect(serialized).toContain("STAGE_TOOL_UNDECLARED");
  });

  test("② 单调 deny：[deny,allow] 与 [allow,deny] 任意顺序均保持 DENY", async () => {
    const scenarios = [
      { name: "deny-then-allow", reasons: ["blocked-first", "ALLOW"] },
      { name: "allow-then-deny", reasons: ["ALLOW", "blocked-second"] },
    ] as const;

    for (const scenario of scenarios) {
      const gate = createPermissionGate();
      gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
      for (const reason of scenario.reasons) {
        if (reason === "ALLOW") {
          gate.addBeforeToolCall((_context, next) => next({ behavior: "ALLOW" }));
        } else {
          gate.addBeforeToolCall((_context, next) => next({ behavior: "DENY", reason }));
        }
      }
      const { agent, events, executions } = gatedHarness({ gate, turns: 1 });
      await agent.prompt("go");

      expect(executions()).toBe(0);
      const ends = endResults(events);
      expect(ends[0]?.isError).toBe(true);
      const reason = scenario.reasons.find((item) => item !== "ALLOW") ?? "";
      expect(JSON.stringify(ends[0]?.result)).toContain(reason);
    }
  });

  test("③ 增删 hook / declareTools 热更新后下一次调用立即生效，无需重建 agent", async () => {
    const gate = createPermissionGate();
    const { agent, events, executions } = gatedHarness({ gate, turns: 4 });

    // 未声明 → DENY
    await agent.prompt("go");
    expect(executions()).toBe(0);
    expect(JSON.stringify(endResults(events)[0]?.result)).toContain("STAGE_TOOL_UNDECLARED");

    // 热新增声明 → 下一次调用即 ALLOW
    gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
    await agent.continue();
    expect(executions()).toBe(1);
    expect(endResults(events)[1]?.isError).toBe(false);

    // 热新增 hook → 下一次调用即 DENY；disposer 纳入 facade 生命周期栈
    const stopHook = agent.api.trackDisposer(
      gate.addBeforeToolCall((_context, next) => next({ behavior: "DENY", reason: "hot-deny" }))
    );
    expect(gate.hookCount).toBe(1);
    await agent.continue();
    expect(executions()).toBe(1);
    expect(endResults(events)[2]?.isError).toBe(true);
    expect(JSON.stringify(endResults(events)[2]?.result)).toContain("hot-deny");

    // 撤销 hook（幂等）→ 下一次调用恢复 ALLOW
    stopHook();
    stopHook();
    expect(gate.hookCount).toBe(0);
    await agent.continue();
    expect(executions()).toBe(2);
    expect(endResults(events)[3]?.isError).toBe(false);

    await agent.continue();
  });

  test("④ 不注入 gate 时工具与前后钩子行为与基线一致", async () => {
    let turn = 0;
    let executions = 0;
    const calls: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" };
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
        executions += 1;
        return "OK";
      },
    } as never);
    agent.api.addBeforeToolCall(() => { calls.push("before"); });
    agent.api.addAfterToolCall(() => { calls.push("after"); });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });

    await agent.prompt("go");

    expect(executions).toBe(1);
    expect(calls).toEqual(["before", "after"]);
    const ends = endResults(events);
    expect(ends[0]?.isError).toBe(false);
    expect(ends[0]?.result).toBe("OK");
  });
});
