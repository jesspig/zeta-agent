import { describe, expect, test } from "bun:test";
import {
  createTerminationController,
  createToolRegistry,
  type ToolDescriptor,
  type ToolExecuteContext,
  type ToolUpdate,
} from "./pipeline";
import { executeConditionalBatch, type ConditionalCall } from "./parallel";

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "tool",
    inputSchema: [],
    outputSchema: ["ok"],
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

function registryWith(...tools: ToolDescriptor[]) {
  const registry = createToolRegistry();
  for (const tool of tools) registry.registerTool(tool);
  return registry;
}

function timed<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 1000)),
  ]);
}

describe("T-17 conditional parallel, terminate and late updates", () => {
  test("independent calls all start via allSettled and a failure does not block peers", async () => {
    let started = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = descriptor({
      name: "slow",
      execute: () => {
        started += 1;
        return gate.then(() => ({ ok: "slow" }));
      },
    });
    const fast = descriptor({
      name: "fast",
      execute: () => {
        started += 1;
        release();
        return { ok: "fast" };
      },
    });
    const failing = descriptor({
      name: "failing",
      outputSchema: ["ok"],
      execute: () => {
        throw new Error("boom");
      },
    });
    const batch: ConditionalCall[] = [
      { id: "s", tool: "slow", input: {} },
      { id: "f", tool: "fast", input: {} },
      { id: "x", tool: "failing", input: {} },
    ];
    const results = await timed(executeConditionalBatch(batch, { registry: registryWith(slow, fast, failing) }));
    expect(started).toBe(2);
    expect(results.map((result) => result.callId)).toEqual(["s", "f", "x"]);
    expect(results[0]?.output).toEqual({ ok: "slow" });
    expect(results[1]?.output).toEqual({ ok: "fast" });
    expect(results[2]?.isError).toBe(true);
  });

  test("a failed dependency makes the dependent fail closed without execution", async () => {
    let executed = 0;
    const base = descriptor({ name: "base", execute: () => undefined });
    const dependent = descriptor({
      name: "dependent",
      execute: () => {
        executed += 1;
        return { ok: true };
      },
    });
    const batch: ConditionalCall[] = [
      { id: "a", tool: "base", input: {} },
      { id: "b", tool: "dependent", input: {}, dependsOn: ["a"] },
    ];
    const results = await executeConditionalBatch(batch, { registry: registryWith(base, dependent) });
    expect(executed).toBe(0);
    expect(results[0]?.isError).toBe(true);
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.reason).toContain("TOOL_DEPENDENCY_UNSATISFIED");
  });

  test("a missing dependency fails closed", async () => {
    let executed = 0;
    const dependent = descriptor({
      name: "dependent",
      execute: () => {
        executed += 1;
        return { ok: true };
      },
    });
    const results = await executeConditionalBatch(
      [{ id: "b", tool: "dependent", input: {}, dependsOn: ["ghost"] }],
      { registry: registryWith(dependent) }
    );
    expect(executed).toBe(0);
    expect(results[0]?.reason).toContain("TOOL_DEPENDENCY_UNSATISFIED");
  });

  test("a single terminate in a mixed batch does not abort peers (#10)", async () => {
    // 语义修正（D-02）：仅整批全 terminate 才停止；混合批次继续执行后续 call。
    const executed: string[] = [];
    const first = descriptor({
      name: "first",
      execute: (_input, exec) => {
        executed.push("first");
        exec.terminate("halt");
        return { ok: true };
      },
    });
    const later = (name: string): ToolDescriptor =>
      descriptor({
        name,
        execute: () => {
          executed.push(name);
          return { ok: true };
        },
      });
    const batch: ConditionalCall[] = [
      { id: "a", tool: "first", input: {} },
      { id: "b", tool: "second", input: {}, dependsOn: ["a"] },
      { id: "c", tool: "third", input: {}, dependsOn: ["a"] },
    ];
    const controller = createTerminationController();
    const results = await executeConditionalBatch(batch, {
      registry: registryWith(first, later("second"), later("third")),
      controller,
    });
    expect(controller.terminated).toBe(false);
    expect(executed).toEqual(["first", "second", "third"]);
    expect(results[1]?.isError).toBe(false);
    expect(results[2]?.isError).toBe(false);
  });

  test("mixed terminate batch continues: only all-terminate stops the batch (#10)", async () => {
    // 设计不变量 #10：仅当整批所有 finalized result 的 terminate===true 才停止，
    // 混合批次（a terminate、b 不 terminate）应继续执行 b。
    const executed: string[] = [];
    const terminating = descriptor({
      name: "terminating",
      execute: (_input, exec) => {
        executed.push("a");
        exec.terminate("halt");
        return { ok: true };
      },
    });
    const normal = descriptor({
      name: "normal",
      execute: () => {
        executed.push("b");
        return { ok: true };
      },
    });
    const batch: ConditionalCall[] = [
      { id: "a", tool: "terminating", input: {} },
      { id: "b", tool: "normal", input: {}, dependsOn: ["a"] },
    ];
    const controller = createTerminationController();
    const results = await executeConditionalBatch(batch, {
      registry: registryWith(terminating, normal),
      controller,
    });
    expect(executed).toEqual(["a", "b"]);
    expect(results[1]?.isError).toBe(false);
    expect(controller.terminated).toBe(false);
  });

  test("all-terminate batch stops: every result terminate=true (T-03 #10)", async () => {
    const executed: string[] = [];
    const make = (name: string): ToolDescriptor =>
      descriptor({
        name,
        execute: (_input, exec) => {
          executed.push(name);
          exec.terminate("halt");
          return { ok: true };
        },
      });
    const batch: ConditionalCall[] = [
      { id: "a", tool: "a", input: {} },
      { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
    ];
    const controller = createTerminationController();
    const results = await executeConditionalBatch(batch, {
      registry: registryWith(make("a"), make("b")),
      controller,
    });
    expect(executed).toEqual(["a", "b"]);
    expect(controller.terminated).toBe(true);
    expect(results[1]?.reason).toContain("BATCH_TERMINATED");
  });

  test("late onUpdate callbacks are dropped after the batch settles", async () => {
    const events: string[] = [];
    let captured: ToolExecuteContext | undefined;
    const tool = descriptor({
      name: "streaming",
      execute: (_input, exec) => {
        captured = exec;
        exec.onUpdate("early");
        return { ok: true };
      },
    });
    await executeConditionalBatch([{ id: "s", tool: "streaming", input: {} }], {
      registry: registryWith(tool),
      onUpdate: (update: ToolUpdate) => events.push(String(update.partialResult)),
    });
    expect(events).toEqual(["early"]);
    captured?.onUpdate("late");
    expect(events).toEqual(["early"]);
  });

  test("async onUpdate callbacks are awaited before settle", async () => {
    let flushed = false;
    const tool = descriptor({
      name: "streaming",
      execute: (_input, exec) => {
        exec.onUpdate("deferred");
        return { ok: true };
      },
    });
    await executeConditionalBatch([{ id: "s", tool: "streaming", input: {} }], {
      registry: registryWith(tool),
      onUpdate: async () => {
        await Promise.resolve();
        flushed = true;
      },
    });
    expect(flushed).toBe(true);
  });

  test("results preserve the original batch order across waves", async () => {
    const order: string[] = [];
    const make = (name: string): ToolDescriptor =>
      descriptor({
        name,
        execute: () => {
          order.push(name);
          return { ok: name };
        },
      });
    const batch: ConditionalCall[] = [
      { id: "c", tool: "c", input: {}, dependsOn: ["a"] },
      { id: "a", tool: "a", input: {} },
      { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
    ];
    const results = await executeConditionalBatch(batch, {
      registry: registryWith(make("a"), make("b"), make("c")),
    });
    expect(results.map((result) => result.callId)).toEqual(["c", "a", "b"]);
  });
});
