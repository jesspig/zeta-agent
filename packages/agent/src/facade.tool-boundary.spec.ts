import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";

/**
 * CR-01 / T-01：普通正文不应被解释为工具请求。
 * 结构化 tool_call（{type:"tool_call"}）始终是合法通道；文本标记仅在显式 opt-in 时生效。
 */
describe("T-01 结构化工具调用边界", () => {
  test("默认配置下文本中的工具标记不会触发工具执行", async () => {
    let executed = 0;
    let turn = 0;
    const agent = createAgent({
      includeBuiltins: true,
      streamFn: async function* () {
        turn += 1;
        if (turn === 1) yield "用户引用了一段文本: @@TOOL:ls:{\"path\":\".\"}@@";
      },
    });
    agent.api.registerTool({
      name: "ls",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "EXECUTED";
      },
    } as never);

    const messages = await agent.prompt("请复述");
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(executed).toBe(0);
    expect(toolResults).toHaveLength(0);
    // 标记作为普通文本保留，未被剥离
    const assistant = messages.filter((m) => m.role === "assistant").at(-1);
    expect(String(assistant?.content)).toContain("@@TOOL:ls:");
  });

  test("显式 opt-in 时文本标记仍可触发工具（兼容既有测试夹具）", async () => {
    let executed = 0;
    const agent = createAgent({
      allowTextToolMarkers: true,
      streamFn: async function* () {
        yield '@@TOOL:probe:{}@@';
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "pong";
      },
    } as never);
    const messages = await agent.prompt("go");
    expect(executed).toBe(1);
    expect(messages.some((m) => m.role === "toolResult")).toBe(true);
  });

  test("结构化 tool_call 始终可执行（不经文本标记门）", async () => {
    let executed = 0;
    let turn = 0;
    const agent = createAgent({
      streamFn: async function* () {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "structured", arguments: "{}" } as never;
        }
      },
    });
    agent.api.registerTool({
      name: "structured",
      description: "probe",
      parameters: [],
      execute: () => {
        executed += 1;
        return "ok";
      },
    } as never);
    const messages = await agent.prompt("go");
    expect(executed).toBe(1);
    expect(messages.some((m) => m.role === "toolResult")).toBe(true);
  });
});
