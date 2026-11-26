import { describe, expect, test } from "bun:test";
import { createAgent, type AgentStreamChunk } from "./facade";

describe("T-14 durable receipt 真实回填", () => {
  test("跨回合重复同参数发射：只执行一次，两回合都回填第一次的真实回执", async () => {
    let turn = 0;
    let executions = 0;
    const args = { path: "/tmp/facade-receipt.txt", content: "same" };
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1 || turn === 2) {
          yield { type: "tool_call", id: `c${turn}`, name: "write", arguments: JSON.stringify(args) };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "write",
      description: "write",
      parameters: [],
      execute: (input: Readonly<Record<string, unknown>>) => {
        executions += 1;
        return { ok: true, echoed: input };
      },
    } as never);

    const messages = await agent.prompt("go");
    expect(executions).toBe(1);

    const receipts = agent.emissionReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: "write", ok: true, generation: 1 });
    expect(receipts[0]?.idempotencyKey?.startsWith("write\u0000write:")).toBe(true);

    const results = messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.content).toEqual({ ok: true, echoed: args });
    }
  });
});
