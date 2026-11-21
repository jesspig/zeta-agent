import { expect, test } from "bun:test";
import { createAgent, MODES, type AgentStreamFn } from "@zeta-agent/agent";

test("U-11 端到端：提示词经 agent 流式转换为 print 输出", async () => {
  const streamFn: AgentStreamFn = async function* (request) {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    yield `echo:${text}`;
  };
  const agent = createAgent({ streamFn });
  const output: string[] = [];
  const code = await MODES.print.run(agent, {
    prompt: "hello e2e",
    output: (line) => { output.push(line); },
  });
  expect(code).toBe(0);
  expect(output).toContain("user: hello e2e");
  expect(output).toContain("assistant: echo:hello e2e");
});
