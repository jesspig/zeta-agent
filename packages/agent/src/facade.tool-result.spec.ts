import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";

/** CR-21：工具返回 ok:false 的结果必须传播为 isError，不能当作成功。 */
describe("T-21 工具失败状态传播", () => {
  test("返回 ok:false 的工具结果产生 isError 的 tool_execution_end", async () => {
    let turn = 0;
    const agent = createAgent({
      streamFn: async function* () {
        turn += 1;
        if (turn === 1) yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" } as never;
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => ({ ok: false, error: "FAILED", stdout: "", stderr: "details" }),
    } as never);
    const events: Array<{ type: string; isError?: boolean }> = [];
    agent.subscribe((e) => { events.push(e as never); });
    await agent.prompt("go");
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end?.isError).toBe(true);
  });
});
