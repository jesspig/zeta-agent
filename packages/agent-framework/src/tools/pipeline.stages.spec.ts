import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent, type AgentMessage } from "../runtime/agent";
import { createInbox } from "../runtime/inbox";
import { runLoop, type AssistantResult, type LoopRuntime } from "../runtime/loop";
import { executeConditionalBatch, type ConditionalCall } from "./parallel";
import {
  createTerminationController,
  createToolPipeline,
  createToolRegistry,
  declareToolChanges,
  executeBatch,
  executeCall,
  runToolCall,
  shouldTerminateToolBatch,
  type ToolDescriptor,
  type ToolResult,
} from "./pipeline";

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "search",
    inputSchema: ["query"],
    outputSchema: ["hits"],
    execute: (input) => ({ hits: [input.query] }),
    ...overrides,
  };
}

function registryWith(...tools: ToolDescriptor[]) {
  const registry = createToolRegistry();
  for (const tool of tools) registry.registerTool(tool);
  return registry;
}

describe("T-03 prepare/execute/finalize 三段管线", () => {
  test("prepareArguments → beforeToolCall → execute → afterToolCall 顺序可观察", async () => {
    const order: string[] = [];
    const registry = registryWith(
      descriptor({
        prepareArguments: (args) => {
          order.push("prepareArguments");
          return args;
        },
        execute: (input) => {
          order.push("execute");
          return { hits: [input.query] };
        },
      })
    );
    const result = await executeCall(
      { id: "c1", tool: "search", input: { query: "q" } },
      {
        registry,
        beforeToolCall: () => {
          order.push("beforeToolCall");
        },
        afterToolCall: () => {
          order.push("afterToolCall");
          return { content: { hits: ["from-hook"] }, structuredContent: { rows: 1 } };
        },
      }
    );
    expect(order).toEqual(["prepareArguments", "beforeToolCall", "execute", "afterToolCall"]);
    expect(result.output).toEqual({ hits: ["from-hook"] });
    expect(result.structuredContent).toEqual({ rows: 1 });
    expect(result.message?.role).toBe("toolResult");
  });

  test("after.content 覆盖时 structuredContent 清空；显式值优先", async () => {
    const registry = registryWith(descriptor());
    const [cleared] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      afterToolCall: () => ({ content: { hits: [] } }),
    });
    expect(cleared?.structuredContent).toBeUndefined();

    const [explicit] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      afterToolCall: () => ({ content: { hits: [] }, structuredContent: { kept: true } }),
    });
    expect(explicit?.structuredContent).toEqual({ kept: true });
  });

  test("beforeToolCall block 不进入 execute，异常归一化为错误结果", async () => {
    let executed = 0;
    const registry = registryWith(descriptor({ execute: () => (executed += 1, { hits: [] }) }));
    const [blocked] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      beforeToolCall: () => ({ block: true, reason: "forbidden", terminate: true }),
    });
    expect(executed).toBe(0);
    expect(blocked?.reason).toContain("TOOL_BLOCKED_BY_HOOK");
    expect(blocked?.terminate).toBe(true);

    const [crashed] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      beforeToolCall: () => {
        throw new Error("HOOK_CRASH");
      },
    });
    expect(crashed?.isError).toBe(true);
    expect(crashed?.reason).toContain("TOOL_PREPARE_ERROR");
  });

  test("executionMode=sequential 逐条 await；默认并行 preflight 串行且结果按源码顺序", async () => {
    const trace: string[] = [];
    const first = descriptor({
      name: "first",
      inputSchema: [],
      outputSchema: ["ok"],
      prepareArguments: () => (trace.push("prepare:first"), {}),
      execute: () => (trace.push("start:first"), { ok: 1 }),
    });
    const second = descriptor({
      name: "second",
      inputSchema: [],
      outputSchema: ["ok"],
      prepareArguments: () => (trace.push("prepare:second"), {}),
      execute: () => (trace.push("start:second"), { ok: 2 }),
    });
    const registry = registryWith(first, second);
    const batch = [
      { id: "a", tool: "first", input: {} },
      { id: "b", tool: "second", input: {} },
    ];
    await executeBatch(batch, { registry, toolExecution: "sequential" });
    expect(trace).toEqual(["prepare:first", "start:first", "prepare:second", "start:second"]);

    trace.length = 0;
    const results = await executeBatch(batch, { registry, toolExecution: "parallel" });
    expect(results.map((result) => result.callId)).toEqual(["a", "b"]);
    expect(trace.slice(0, 2)).toEqual(["prepare:first", "prepare:second"]);
    expect(trace).toContain("start:first");
    expect(trace).toContain("start:second");
  });

  test("durationMs 只计 execute()，onUpdate 的 promise 等待不计入", async () => {
    let now = 100;
    let flushed = false;
    const registry = registryWith(
      descriptor({
        execute: (input, exec) => {
          exec.onUpdate("early");
          now += 5;
          return { hits: [input.query] };
        },
      })
    );
    const [result] = await executeBatch([{ id: "c1", tool: "search", input: { query: "q" } }], {
      registry,
      clock: () => now,
      onUpdate: async () => {
        await Promise.resolve();
        now += 50;
        flushed = true;
      },
    });
    expect(flushed).toBe(true);
    expect(result?.durationMs).toBe(5);
  });

  test("legacy 适配器整批 terminate：混合继续，全终止才停止", async () => {
    const executed: string[] = [];
    const terminating = descriptor({
      name: "terminating",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: (_input, exec) => (executed.push("terminating"), exec.terminate(), { ok: true }),
    });
    const normal = descriptor({
      name: "normal",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: () => (executed.push("normal"), { ok: true }),
    });
    const registry = registryWith(terminating, normal);
    // 字段赋值式 legacy 路径：逐条执行后统一按 finalized 结果判定。
    const legacyBatch = async (batch: readonly ConditionalCall[], controller = createTerminationController()) => {
      const results: ToolResult[] = [];
      for (const call of batch) results.push(await executeCall(call, { registry, controller }));
      if (shouldTerminateToolBatch(results)) {
        controller.terminate("all-terminated");
        return results.map((result) => ({ ...result, isError: true, reason: "BATCH_TERMINATED" }));
      }
      return results;
    };

    const mixedController = createTerminationController();
    const mixed = await legacyBatch(
      [
        { id: "a", tool: "terminating", input: {} },
        { id: "b", tool: "normal", input: {} },
      ],
      mixedController
    );
    expect(executed).toEqual(["terminating", "normal"]);
    expect(mixedController.terminated).toBe(false);
    expect(mixed[1]?.isError).toBe(false);

    executed.length = 0;
    const allController = createTerminationController();
    const all = await legacyBatch(
      [
        { id: "a", tool: "terminating", input: {} },
        { id: "b", tool: "terminating", input: {} },
      ],
      allController
    );
    expect(executed).toEqual(["terminating", "terminating"]);
    expect(allController.terminated).toBe(true);
    expect(all[1]?.reason).toContain("BATCH_TERMINATED");
  });

  test("declareToolChanges 产出工具声明 delta 与 system 消息", async () => {
    const delta = declareToolChanges(["read"], ["read", "write", "edit"], "sys");
    expect(delta.toolsAdded).toEqual(["write", "edit"]);
    expect(delta.toolsRemoved).toEqual([]);
    expect(String(delta.messages[0]?.content)).toContain("sys");
    expect(String(delta.messages[0]?.content)).toContain("tools: edit, read, write");

    const removal = declareToolChanges(["read", "write"], ["read"]);
    expect(removal.toolsRemoved).toEqual(["write"]);

    const stream = createEventStream();
    const order: string[] = [];
    stream.subscribe((event) => {
      order.push(event.type);
    });
    const inbox = createInbox();
    inbox.followUp({ role: "user", content: "go" });
    const systemMessage: AgentMessage = { role: "system", content: "sys (tools: read)" };
    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      declareToolChanges: () => ({ toolsAdded: ["read"], toolsRemoved: [], messages: [systemMessage] }),
      streamAssistant: async (): Promise<AssistantResult> => ({
        message: { role: "assistant", content: "ok" },
        toolCalls: [],
        stopReason: "stop",
      }),
      finishTurn: () => ({ action: "end" }),
    };
    await runLoop(runtime);
    const systems = stream
      .getState()
      .messages.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]).toBe(systemMessage);
    expect(order.indexOf("message_end")).toBeLessThan(order.indexOf("turn_end"));
  });
});

describe("T-03 runToolCall 嵌套复用同一管线但不发事件不加消息", () => {
  test("loop 接入统一管线时嵌套调用只触发一次工具事件与一条 toolResult", async () => {
    const registry = registryWith(descriptor());
    const stream = createEventStream();
    const events: AgentEvent[] = [];
    stream.subscribe((event: AgentEvent) => {
      events.push(event);
    });
    const inbox = createInbox();
    inbox.followUp({ role: "user", content: "go" });

    let nested: ToolResult | undefined;
    let nestedStarted = false;
    let pipeline: ReturnType<typeof createToolPipeline>;
    pipeline = createToolPipeline({
      registry,
      afterToolCall: async () => {
        if (nestedStarted) return;
        nestedStarted = true;
        // loop 形状（name/args）与 pipeline 形状（tool/input）共用同一入口。
        nested = await pipeline.runToolCall({ id: "nested", name: "search", args: { query: "n" } });
      },
    });

    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      toolPipeline: pipeline,
      streamAssistant: async (): Promise<AssistantResult> => ({
        message: { role: "assistant", content: "ok" },
        toolCalls: [{ id: "c1", name: "search", args: { query: "q" } }],
        stopReason: "stop",
      }),
      finishTurn: () => ({ action: "end" }),
    };

    const before = stream.getState().messages.length;
    await runLoop(runtime);
    expect(nested).toBeDefined();
    expect(nested?.message).toBeUndefined();
    expect(nested?.output).toEqual({ hits: ["n"] });
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
    const toolResultMessages = stream
      .getState()
      .messages.filter((message) => message.role === "toolResult");
    expect(toolResultMessages).toHaveLength(1);
    // steering 的 user 消息 + assistant + 唯一一条 toolResult；嵌套调用不追加消息。
    expect(stream.getState().messages.length).toBe(before + 3);
  });

  test("独立 runToolCall 复用 before/after 钩子且不返回 message", async () => {
    const hooks: string[] = [];
    const registry = registryWith(descriptor());
    const result = await runToolCall(
      { id: "n1", name: "search", args: { query: "direct" } },
      {
        registry,
        beforeToolCall: () => void hooks.push("before"),
        afterToolCall: () => void hooks.push("after"),
      }
    );
    expect(hooks).toEqual(["before", "after"]);
    expect(result.message).toBeUndefined();
    expect(result.output).toEqual({ hits: ["direct"] });
  });
});

describe("T-03 条件批次与全批次终止兼容", () => {
  test("executeConditionalBatch 仍按源码顺序落盘且混合批次不终止", async () => {
    const registry = registryWith(
      descriptor({
        name: "a",
        inputSchema: [],
        outputSchema: ["ok"],
        execute: (_input, exec) => (exec.terminate(), { ok: true }),
      }),
      descriptor({ name: "b", inputSchema: [], outputSchema: ["ok"], execute: () => ({ ok: true }) })
    );
    const controller = createTerminationController();
    const results = await executeConditionalBatch(
      [
        { id: "a", tool: "a", input: {} },
        { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
      ],
      { registry, controller }
    );
    expect(results.map((result) => result.callId)).toEqual(["a", "b"]);
    expect(controller.terminated).toBe(false);
    expect(results[1]?.isError).toBe(false);
  });
});
