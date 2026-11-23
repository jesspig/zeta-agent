import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";

/** CR-03：默认占位后端能力声明为 unsupported，不得把未执行的命令报告为成功。 */
describe("T-03 默认安全后端失败关闭", () => {
  test("未注入真实后端时命令工具因能力降级失败关闭，绝不报告成功", async () => {
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
    expect(String(record.error ?? "")).toMatch(/CRITICAL_LAYER_DEGRADED|COMMAND_FAILED|NO_REAL_EXECUTION_BACKEND/i);
  });
});
