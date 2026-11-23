import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentStreamChunk } from "./facade";
import { createAgent } from "./facade";
import { createPermissionGate } from "./plugins/permissions/guard";

function tool(name: string, execute: () => unknown) {
  return { name, description: name, parameters: [], execute } as never;
}

describe("T-04 facade 装配收敛", () => {
  test("运行中注入 steer/followUp 在下一轮进入 transcript", async () => {
    let turn = 0;
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          agent.steer({ role: "user", content: "steer-注入" });
          agent.followUp({ role: "user", content: "followUp-注入" });
          yield { type: "tool_call", id: "c1", name: "ping", arguments: "{}" };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool(tool("ping", () => "PONG"));

    const messages = await agent.prompt("start");

    expect(turn).toBe(2);
    const userContents = messages
      .filter((message) => message.role === "user")
      .map((message) => String(message.content));
    expect(userContents).toEqual(["start", "steer-注入", "followUp-注入"]);
  });

  test("reset 清理持久 inbox 中尚未消费的注入", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "ok";
      },
    });
    agent.steer({ role: "user", content: "残留" });
    agent.followUp({ role: "user", content: "残留-followUp" });
    agent.reset();

    await agent.prompt("fresh");

    const userContents = agent.state.messages
      .filter((message) => message.role === "user")
      .map((message) => String(message.content));
    expect(userContents).toEqual(["fresh"]);
  });

  test("工具热插拔后 transcript 声明同步", async () => {
    let turn = 0;
    let disposeHot: (() => void) | undefined;
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          disposeHot = agent.api.registerTool(tool("hot_tool", () => "HOT"));
          yield { type: "tool_call", id: "c1", name: "ping", arguments: "{}" };
          return;
        }
        if (turn === 2) {
          disposeHot?.();
          yield { type: "tool_call", id: "c2", name: "ping", arguments: "{}" };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool(tool("ping", () => "PONG"));
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    const messages = await agent.prompt("start");

    expect(turn).toBe(3);
    const declarations = messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content));
    expect(declarations).toEqual(["tools: ping", "tools: hot_tool, ping", "tools: ping"]);
    const emitted = events.filter(
      (event) => event.type === "message_start" && event.message.role === "system"
    );
    expect(emitted).toHaveLength(declarations.length);
  });

  test("权限策略热更新不产生工具声明、不触发 reload", async () => {
    const gate = createPermissionGate();
    let turn = 0;
    let declarationsAtUpdate = -1;
    const agent = createAgent({
      includeBuiltins: false,
      permissionGate: gate,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          declarationsAtUpdate = agent.state.messages.filter((message) => message.role === "system").length;
          const namesBefore = [...agent.toolNames];
          gate.declareTools([{ tool: "probe", stages: ["plan"] }]);
          gate.addBeforeToolCall((_context, next) => next({ behavior: "ALLOW" }));
          expect(agent.toolNames).toEqual(namesBefore);
          yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool(tool("probe", () => "OK"));

    const messages = await agent.prompt("go");

    expect(turn).toBe(2);
    expect(declarationsAtUpdate).toBe(1);
    const declarations = messages.filter((message) => message.role === "system");
    expect(declarations).toHaveLength(declarationsAtUpdate);
  });
});
