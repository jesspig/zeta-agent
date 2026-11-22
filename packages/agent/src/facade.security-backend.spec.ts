import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";

/** CR-03：默认占位后端不得把未执行的命令报告为成功。 */
describe("T-03 默认安全后端失败关闭", () => {
  test("未注入真实后端时命令工具返回失败而非成功", async () => {
    let turn = 0;
    const agent = createAgent({
      streamFn: async function* () {
        turn += 1;
        if (turn === 1) yield '@@TOOL:bash:{"command":"echo hi"}@@';
      },
      allowTextToolMarkers: true,
    });
    const messages = await agent.prompt("run");
    const toolResult = [...messages].reverse().find((m) => m.role === "toolResult");
    const content = toolResult?.content;
    const record = typeof content === "object" && content !== null
      ? (content as Record<string, unknown>)
      : {};
    expect(record.ok).toBe(false);
    expect(String(record.error ?? "")).toMatch(/COMMAND_FAILED|NO_REAL_EXECUTION_BACKEND/i);
  });
});
