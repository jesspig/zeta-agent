import { describe, expect, test } from "bun:test";
import { AgentPluginManager } from "../plugins/manager";
import {
  createTerminationController,
  createToolLeaseManager,
  createToolPipeline,
  createToolRegistry,
  executeBatch,
  runToolCall,
  type ToolAuditEvent,
  type ToolDescriptor,
} from "./pipeline";
import { inputSchemaFromParameters } from "./types";
import { executeConditionalBatch, type ConditionalCall } from "./parallel";

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "tool",
    inputSchema: [],
    outputSchema: undefined,
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

function registryWith(...tools: ToolDescriptor[]) {
  const registry = createToolRegistry();
  for (const tool of tools) registry.registerTool(tool);
  return registry;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("T-08 completion sink / cleanup acknowledgement", () => {
  test("finalize completion sink fires in completion order while results keep source order", async () => {
    const order: string[] = [];
    const registry = registryWith(
      descriptor({
        name: "slow",
        execute: async () => {
          await delay(25);
          return { ok: "slow" };
        },
      }),
      descriptor({
        name: "fast",
        execute: async () => {
          await delay(2);
          return { ok: "fast" };
        },
      })
    );
    const results = await executeBatch(
      [
        { id: "a", tool: "slow", input: {} },
        { id: "b", tool: "fast", input: {} },
      ],
      { registry, completionSink: (result) => void order.push(result.callId) }
    );
    expect(order).toEqual(["b", "a"]);
    expect(results.map((result) => result.callId)).toEqual(["a", "b"]);
  });

  test("completion sink waits for cleanup acknowledgement and fails closed on cleanup error", async () => {
    let acknowledge = (): void => {};
    const acked = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const published: string[] = [];
    const registry = registryWith(
      descriptor({
        name: "guarded",
        cleanup: () => acked,
      })
    );
    const running = executeBatch([{ id: "c1", tool: "guarded", input: {} }], {
      registry,
      completionSink: (result) => void published.push(result.callId),
    });
    await delay(5);
    expect(published).toEqual([]);
    acknowledge();
    await running;
    expect(published).toEqual(["c1"]);

    const failing = registryWith(descriptor({ name: "bad-cleanup", cleanup: () => { throw new Error("CLEANUP_CRASH"); } }));
    const [result] = await executeBatch([{ id: "c2", tool: "bad-cleanup", input: {} }], {
      registry: failing,
      completionSink: (item) => void published.push(item.callId),
    });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_CLEANUP_FAILED");
  });
});

describe("T-08 validation, budgets and hook fail-closed", () => {
  test("before hook rewritten args are revalidated before execute", async () => {
    let executed = 0;
    const registry = registryWith(
      descriptor({
        name: "search",
        inputSchema: ["query"],
        execute: () => {
          executed += 1;
          return { ok: true };
        },
      })
    );
    const [result] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      beforeToolCall: () => ({ args: { query: "q", extra: "leak" } }),
    });
    expect(executed).toBe(0);
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_INPUT_EXTRA_FIELD");
  });

  test("full JSON Schema checks required fields and types", async () => {
    const schema = {
      type: "object" as const,
      properties: {
        path: { type: "string" as const },
        count: { type: "number" as const },
      },
      required: ["path"],
      additionalProperties: false,
    };
    const registry = registryWith(descriptor({ name: "typed", inputSchema: schema }));
    const missing = await executeBatch([{ id: "c1", tool: "typed", input: {} }], { registry });
    expect(missing[0]?.isError).toBe(true);
    expect(missing[0]?.reason).toContain("TOOL_INPUT_REQUIRED");
    const wrongType = await executeBatch([{ id: "c2", tool: "typed", input: { path: 42 } }], { registry });
    expect(wrongType[0]?.isError).toBe(true);
    expect(wrongType[0]?.reason).toContain("TOOL_INPUT_TYPE");
    const valid = await executeBatch([{ id: "c3", tool: "typed", input: { path: "ok" } }], { registry });
    expect(valid[0]?.isError).toBe(false);
  });

  test("hook chain failure fails closed instead of falling back to legacy", async () => {
    const manager = new AgentPluginManager({ config: { enabled: true, fallbackToLegacy: true } });
    manager.addHook("beforeToolCall", () => {
      throw new Error("HOOK_CRASH");
    });
    const registry = registryWith(descriptor({ name: "probe" }));
    const [result] = await executeBatch([{ id: "c1", tool: "probe", input: {} }], { registry, manager });
    expect(result?.isError).toBe(true);
    expect(result?.reason).toContain("TOOL_PREPARE_ERROR");
  });

  test("after hook and publisher failures fail closed", async () => {
    const registry = registryWith(descriptor({ name: "probe" }));
    const [afterFailure] = await executeBatch([{ id: "c1", tool: "probe", input: {} }], {
      registry,
      afterToolCall: () => {
        throw new Error("AFTER_CRASH");
      },
    });
    expect(afterFailure?.isError).toBe(true);
    expect(afterFailure?.reason).toContain("TOOL_FINALIZE_ERROR");

    const [publishFailure] = await executeBatch([{ id: "c2", tool: "probe", input: {} }], {
      registry,
      publisher: () => {
        throw new Error("PUBLISH_CRASH");
      },
    });
    expect(publishFailure?.isError).toBe(true);
    expect(publishFailure?.reason).toContain("TOOL_PUBLISH_ERROR");
  });

  test("retry succeeds after transient failure and timeout fails closed", async () => {
    let attempts = 0;
    const registry = registryWith(
      descriptor({
        name: "flaky",
        retry: { maxAttempts: 3 },
        execute: () => {
          attempts += 1;
          if (attempts < 3) throw new Error("TRANSIENT");
          return { ok: true };
        },
      }),
      descriptor({
        name: "hang",
        timeoutMs: 5,
        execute: () => delay(200).then(() => ({ ok: true })),
      })
    );
    const [flaky, hang] = await executeBatch(
      [
        { id: "a", tool: "flaky", input: {} },
        { id: "b", tool: "hang", input: {} },
      ],
      { registry }
    );
    expect(attempts).toBe(3);
    expect(flaky?.isError).toBe(false);
    expect(hang?.isError).toBe(true);
    expect(hang?.reason).toContain("TOOL_TIMEOUT");
  });

  test("tool-call and output budgets fail closed", async () => {
    const registry = registryWith(
      descriptor({ name: "big", execute: () => ({ ok: "x".repeat(200) }) })
    );
    const calls = [
      { id: "a", tool: "big", input: {} },
      { id: "b", tool: "big", input: {} },
    ];
    const limited = await executeBatch(calls, { registry, budgets: { maxToolCalls: 1 } });
    expect(limited[0]?.isError).toBe(false);
    expect(limited[1]?.isError).toBe(true);
    expect(limited[1]?.reason).toContain("TOOL_CALL_BUDGET_EXCEEDED");

    const tiny = await executeBatch([calls[0]!], { registry, budgets: { maxOutputChars: 10 } });
    expect(tiny[0]?.isError).toBe(true);
    expect(tiny[0]?.reason).toContain("TOOL_OUTPUT_BUDGET_EXCEEDED");
  });
});

describe("T-08 terminate preserves real results", () => {
  test("all-terminate conditional batch keeps real output while terminating", async () => {
    const registry = registryWith(
      descriptor({
        name: "a",
        execute: (_input, exec) => {
          exec.terminate();
          return { ok: "real-a" };
        },
      }),
      descriptor({
        name: "b",
        execute: (_input, exec) => {
          exec.terminate();
          return { ok: "real-b" };
        },
      })
    );
    const controller = createTerminationController();
    const results = await executeConditionalBatch(
      [
        { id: "a", tool: "a", input: {} } as ConditionalCall,
        { id: "b", tool: "b", input: {} } as ConditionalCall,
      ],
      { registry, controller }
    );
    expect(controller.terminated).toBe(true);
    expect(results[0]?.output).toEqual({ ok: "real-a" });
    expect(results[1]?.output).toEqual({ ok: "real-b" });
    expect(results.every((result) => result.terminate === true)).toBe(true);
  });

  test("bound pipeline exposes completion sink via executeBatch argument", async () => {
    const registry = registryWith(descriptor({ name: "x", execute: () => ({ ok: 1 }) }));
    const pipeline = createToolPipeline({ registry });
    const seen: Array<{ readonly callId: string }> = [];
    const results = await pipeline.executeBatch(
      [{ id: "c1", tool: "x", input: {} }],
      undefined,
      (result) => void seen.push(result)
    );
    expect(results).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.callId).toBe("c1");
  });
});

describe("T-08 schema rejection, audit and unified nested path", () => {
  test("declared parameters project to a strict object schema", () => {
    const schema = inputSchemaFromParameters([
      { name: "path", type: "string", description: "file", required: true },
      { name: "verbose", type: "boolean" },
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: { path: { type: "string" }, verbose: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  test("missing/wrong-type/extra inputs are rejected before execute and audited", async () => {
    let executed = 0;
    const schema = {
      type: "object" as const,
      properties: { query: { type: "string" as const } },
      required: ["query"],
      additionalProperties: false,
    };
    const registry = registryWith(
      descriptor({
        name: "typed",
        inputSchema: schema,
        execute: () => {
          executed += 1;
          return { ok: true };
        },
      })
    );
    const audit: ToolAuditEvent[] = [];
    const [missing, wrongType, extra] = await executeBatch(
      [
        { id: "m", tool: "typed", input: {} },
        { id: "w", tool: "typed", input: { query: 7 } },
        { id: "e", tool: "typed", input: { query: "q", injected: true } },
      ],
      { registry, audit: (event) => void audit.push(event) }
    );
    expect(executed).toBe(0);
    expect([missing?.reason, wrongType?.reason, extra?.reason]).toEqual([
      expect.stringContaining("TOOL_INPUT_REQUIRED"),
      expect.stringContaining("TOOL_INPUT_TYPE"),
      expect.stringContaining("TOOL_INPUT_EXTRA_FIELD"),
    ]);
    expect(audit.map((event) => event.phase)).toEqual(["prepare", "prepare", "prepare"]);
    expect(audit.every((event) => event.tool === "typed")).toBe(true);
  });

  test("runToolCall shares publisher but skips completion sink and messages", async () => {
    const registry = registryWith(descriptor({ name: "nested", execute: () => ({ ok: "nested" }) }));
    const published: string[] = [];
    const sunk: string[] = [];
    const result = await runToolCall(
      { id: "n1", tool: "nested", input: {} },
      {
        registry,
        publisher: (item) => {
          published.push(item.callId);
          return item;
        },
        completionSink: (item) => {
          sunk.push(item.callId);
        },
      }
    );
    expect(published).toEqual(["n1"]);
    expect(sunk).toEqual([]);
    expect(result.message).toBeUndefined();
    expect(result.output).toEqual({ ok: "nested" });
  });
});

describe("T-08 tool lease lifecycle", () => {
  test("every call acquires a lease and waitForIdle settles with it", async () => {
    const leases = createToolLeaseManager();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = registryWith(
      descriptor({
        name: "gated",
        execute: () => gate.then(() => ({ ok: true })),
      })
    );
    const running = executeBatch([{ id: "c1", tool: "gated", input: {} }], { registry, toolLeases: leases });
    await delay(5);
    expect(leases.activeIds).toEqual(["c1"]);
    let idle = false;
    const waiting = leases.waitForIdle().then(() => {
      idle = true;
    });
    await delay(5);
    expect(idle).toBe(false);
    release();
    await running;
    await waiting;
    expect(idle).toBe(true);
    expect(leases.activeCount).toBe(0);
  });

  test("timeout cancels the independent lease and confirms cooperative termination", async () => {
    const leases = createToolLeaseManager();
    let observed: AbortSignal | undefined;
    const registry = registryWith(
      descriptor({
        name: "cooperative",
        timeoutMs: 5,
        execute: (_input, exec) => {
          observed = exec.signal;
          return new Promise<never>((_resolve, reject) => {
            exec.signal?.addEventListener("abort", () => reject(new Error("ABORTED_BY_TIMEOUT")));
          });
        },
      })
    );
    const [result] = await executeBatch([{ id: "c1", tool: "cooperative", input: {} }], {
      registry,
      toolLeases: leases,
      timeoutConfirmationMs: 100,
    });
    expect(result?.reason).toContain("TOOL_TIMEOUT");
    expect(result?.reconciliation).toBeUndefined();
    expect(observed?.aborted).toBe(true);
    expect(leases.activeCount).toBe(0);
  });

  test("unconfirmed timeout returns unknown for reconciliation instead of a retryable failure", async () => {
    const leases = createToolLeaseManager();
    let attempts = 0;
    const registry = registryWith(
      descriptor({
        name: "uncooperative",
        timeoutMs: 5,
        retry: { maxAttempts: 3 },
        execute: () => {
          attempts += 1;
          return new Promise<never>(() => {});
        },
      })
    );
    const [result] = await executeBatch([{ id: "c1", tool: "uncooperative", input: {} }], {
      registry,
      toolLeases: leases,
      timeoutConfirmationMs: 5,
    });
    expect(attempts).toBe(1);
    expect(result?.reason).toContain("TOOL_TIMEOUT_UNKNOWN");
    expect(result?.outcome).toBe("unknown");
    expect(result?.reconciliation).toBe(true);
    expect(leases.activeCount).toBe(0);
  });

  test("dispose cancels leases, force-settles unknown and leaves no active lease", async () => {
    const leases = createToolLeaseManager();
    const lease = leases.acquire("leftover");
    expect(leases.activeCount).toBe(1);
    const unknown = await leases.close({ graceMs: 5 });
    expect(unknown).toEqual(["leftover"]);
    expect(lease.outcome).toBe("unknown");
    expect(lease.signal.aborted).toBe(true);
    await expect(leases.waitForIdle()).resolves.toBeUndefined();
  });
});
