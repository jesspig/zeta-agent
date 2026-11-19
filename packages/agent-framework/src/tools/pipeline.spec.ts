import { describe, expect, test } from "bun:test";
import {
  createPermissionGuard,
  createToolRegistry,
  executeBatch,
  PERMISSION_BEHAVIORS,
  validateInput,
  type PermissionVerdict,
  type ToolCall,
  type ToolDescriptor,
} from "./pipeline";

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "search",
    inputSchema: ["query"],
    outputSchema: ["hits"],
    execute: () => ({ hits: [] }),
    ...overrides,
  };
}

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "c1", tool: "search", input: {}, ...overrides };
}

describe("T-16 tool pipeline, monotonic guard and forced output", () => {
  test("permission behavior set is stable", () => {
    expect(PERMISSION_BEHAVIORS).toEqual(["ALLOW", "DENY", "ASK", "PASSTHROUGH"]);
  });

  test("deny cannot be flipped by a later allow", () => {
    const guard = createPermissionGuard();
    const deny: PermissionVerdict = { behavior: "DENY", reason: "blocked" };
    const allow: PermissionVerdict = { behavior: "ALLOW" };
    expect(guard.evaluate([deny, allow]).behavior).toBe("DENY");
    expect(guard.evaluate([allow, deny]).behavior).toBe("DENY");
    expect(guard.evaluate([allow, allow]).behavior).toBe("ALLOW");
    expect(guard.evaluate([]).behavior).toBe("PASSTHROUGH");
    expect(guard.evaluate([{ behavior: "ASK" }, allow]).behavior).toBe("ASK");
  });

  test("bypass cannot flip a bypass-immune deny", () => {
    const guard = createPermissionGuard();
    const immune: PermissionVerdict = { behavior: "DENY", bypassImmune: true };
    const normal: PermissionVerdict = { behavior: "DENY" };
    expect(guard.evaluate([immune], { bypass: true }).behavior).toBe("DENY");
    expect(guard.evaluate([normal], { bypass: true }).behavior).toBe("PASSTHROUGH");
    expect(guard.evaluate([immune, { behavior: "ALLOW" }], { bypass: true }).behavior).toBe("DENY");
  });

  test("input allowlist rejects extra fields", async () => {
    const tool = descriptor();
    expect(() => validateInput(tool, { query: "q", secret: "x" })).toThrow("TOOL_INPUT_EXTRA_FIELD");
    expect(() => validateInput(tool, { query: "q" })).not.toThrow();

    const registry = createToolRegistry();
    registry.registerTool(tool);
    const [result] = await executeBatch([call({ input: { query: "q", secret: "x" } })], { registry });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_INPUT_EXTRA_FIELD");
  });

  test("forced output produces an error result when a tool returns nothing", async () => {
    const registry = createToolRegistry();
    registry.registerTool(descriptor({ execute: () => undefined }));
    const [result] = await executeBatch([call()], { registry });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_OUTPUT_MISSING");
    expect(result?.output).toBeDefined();
  });

  test("output schema rejects undeclared output fields", async () => {
    const registry = createToolRegistry();
    registry.registerTool(descriptor({ execute: () => ({ hits: [], leaked: "x" }) }));
    const [result] = await executeBatch([call()], { registry });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_OUTPUT_EXTRA_FIELD");
  });

  test("durationMs is nonnegative and measures only execute", async () => {
    let now = 100;
    const registry = createToolRegistry();
    registry.registerTool(
      descriptor({
        execute: () => {
          now += 5;
          return { hits: [1] };
        },
      })
    );
    const [result] = await executeBatch([call()], { registry, clock: () => now });
    expect(result?.durationMs).toBe(5);
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result?.isError).toBe(false);
    expect(result?.output).toEqual({ hits: [1] });
  });

  test("permission deny blocks execution with an error result", async () => {
    let invoked = 0;
    const registry = createToolRegistry();
    registry.registerTool(
      descriptor({
        execute: () => {
          invoked += 1;
          return { hits: [] };
        },
      })
    );
    const [result] = await executeBatch([call()], {
      registry,
      verdicts: [{ behavior: "DENY", reason: "blocked" }],
    });
    expect(invoked).toBe(0);
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_PERMISSION_DENIED");
  });

  test("ask fails closed in an automated batch", async () => {
    let invoked = 0;
    const registry = createToolRegistry();
    registry.registerTool(
      descriptor({
        execute: () => {
          invoked += 1;
          return { hits: [] };
        },
      })
    );
    const [result] = await executeBatch([call()], {
      registry,
      verdicts: [{ behavior: "ASK", reason: "confirm" }],
    });
    expect(invoked).toBe(0);
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_PERMISSION_ASK");
  });

  test("registerTool returns a disposer and rejects duplicates", () => {
    const registry = createToolRegistry();
    const dispose = registry.registerTool(descriptor());
    expect(registry.size).toBe(1);
    expect(() => registry.registerTool(descriptor())).toThrow("TOOL_DUPLICATE");
    expect(registry.getTool("search")).toBeDefined();
    dispose();
    expect(registry.size).toBe(0);
    expect(registry.getTool("search")).toBeUndefined();
  });

  test("unknown tool produces an error result without invoking hooks", async () => {
    const registry = createToolRegistry();
    const [result] = await executeBatch([call({ tool: "missing" })], { registry });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_NOT_FOUND");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
