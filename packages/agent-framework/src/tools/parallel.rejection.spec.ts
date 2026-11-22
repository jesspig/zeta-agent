import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "./pipeline";
import { executeConditionalBatch } from "./parallel";

/** CR-18：批次中任何拒绝都必须转成对应调用的失败结果，不能留下 undefined。 */
describe("T-17 条件批次拒绝归一化", () => {
  test("guard 抛错时仍为每个调用返回失败结果", async () => {
    const registry = createToolRegistry();
    registry.registerTool({
      name: "boom",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: () => ({ ok: true }),
    });
    const ctx = {
      registry,
      guard: { evaluate: () => { throw new Error("GUARD_CRASH"); } },
    } as never;
    const results = await executeConditionalBatch(
      [{ id: "c1", tool: "boom", input: {} }],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    expect(results[0]!.isError).toBe(true);
  });
});
