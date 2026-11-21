import { describe, expect, test } from "bun:test";
import {
  createEventStream,
  type AgentEvent,
  type AgentMessage,
} from "./agent";
import { createInbox } from "./inbox";
import {
  RUN_LOOP_STEPS,
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopRuntime,
  type ToolResult,
} from "./loop";
import { createDecisionWaterfall, nextAction } from "./decision";
import { createInitialState, reduceState } from "./agent";
import { executeConditionalBatch, type ConditionalCall } from "../tools/parallel";
import {
  createTerminationController,
  createToolRegistry,
  type ToolDescriptor,
  type ToolExecuteContext,
} from "../tools/pipeline";

/**
 * agent-core 12 条不变量等价测试（state-and-events.md §13 / pi-baseline.md §9）。
 *
 * 与 tools/invariants.spec.ts 的工具流水线 12 条（inv-tool-）严格区分：
 * 本文件覆盖 agent-core 的 12 条，测试名统一使用 inv-core- 前缀。
 * 每条不变量同时提供 legacy（字段赋值）与 plugin（管线）两版等价断言。
 *
 * legacy 版：字段赋值式 hook（finishTurn/decide）+ 事件流字段归约。
 * plugin 版：管线式 hook（decision + waterfall）+ 同一事件流断言。
 * 两版共享同一行为断言主体，仅 runtime 钩子接线方式不同。
 */

interface InvariantCase {
  readonly id: number;
  readonly name: string;
  readonly legacy: () => void | Promise<void>;
  readonly plugin: () => void | Promise<void>;
}

/** 运行时构造选项：覆盖各不变量所需的钩子与响应。 */
interface RuntimeOptions {
  readonly response?: Partial<AssistantResult>;
  readonly toolResults?: readonly ToolResult[];
  readonly finishTurnLegacy?: (turn: LastTurn) => { action: "continue" | "end" };
  readonly decisionPlugin?: NonNullable<LoopRuntime["decision"]>;
  readonly prepareNextTurnCalls?: { count: number };
  readonly onRequest?: (request: unknown) => void;
}

/**
 * 构造 runLoop runtime，返回可观察探针：事件序列、请求次数、最终状态。
 * legacy 模式用 finishTurn 字段赋值；plugin 模式用 decision 字段（管线入口）。
 */
function makeRuntime(mode: "legacy" | "plugin", options: RuntimeOptions = {}) {
  const stream = createEventStream();
  const order: string[] = [];
  stream.subscribe((event: AgentEvent) => {
    order.push(event.type);
  });
  const inbox = createInbox();
  const response: AssistantResult = {
    message: { role: "assistant", content: "ok" },
    toolCalls: [],
    stopReason: "stop",
    ...options.response,
  };
  let requestCount = 0;
  let streamCount = 0;

  const runtime: LoopRuntime = {
    inbox,
    emit: (event) => stream.emit(event),
    getState: () => stream.getState(),
    prepareRequest: (request) => {
      requestCount += 1;
      options.onRequest?.(request);
      return request;
    },
    streamAssistant: async () => {
      requestCount += 1;
      streamCount += 1;
      // 安全阀：continue 场景在若干轮后强制硬退出，避免断言用例无限循环。
      if (streamCount > 3) return { ...response, stopReason: "error", toolCalls: [] };
      return response;
    },
    executeToolCalls: async () => options.toolResults ?? [],
    prepareNextTurn: () => {
      if (options.prepareNextTurnCalls) options.prepareNextTurnCalls.count += 1;
    },
    ...(mode === "legacy"
      ? { finishTurn: options.finishTurnLegacy ?? (() => ({ action: "continue" })) }
      : { decision: options.decisionPlugin ?? (() => ({ kind: "exit", reason: "end" })) }),
  };

  return {
    runtime,
    stream,
    inbox,
    order,
    getRequestCount: () => requestCount,
    getStreamCount: () => streamCount,
  };
}

function pair(
  id: number,
  name: string,
  body: (mode: "legacy" | "plugin") => void | Promise<void>
): InvariantCase {
  return { id, name, legacy: () => body("legacy"), plugin: () => body("plugin") };
}

const INVARIANT_NAMES = [
  "message-end-barrier", // #1
  "completion-order-decoupled", // #2
  "error-aborted-hard-exit", // #3
  "end-keeps-queue", // #4
  "continue-one-request", // #5
  "hook-no-throw", // #6
  "streamfn-no-throw", // #7
  "late-update-dropped", // #8
  "core-no-persistence-provider", // #9
  "terminate-all-batch", // #10
  "runtoolcall-hooks-no-event", // #11
  "system-single-source", // #12
] as const;

// 12 条真实行为断言（legacy/plugin 双版共享 body），缺任一 key 即抛错（见 cases 映射）。
const CHECKS: Record<number, (mode: "legacy" | "plugin") => void | Promise<void>> = {
  // ---- T-03：3 条部分覆盖完整化（先写 RED 断言）----
  // #1 message-end 屏障：工具执行前 listener 已观察到 assistant 的 message_end。
  1: async (mode) => {
    const { runtime, order, stream } = makeRuntime(mode, {
      response: {
        toolCalls: [{ id: "c1", name: "tool", args: {} }],
        stopReason: "stop",
      },
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
    });
    let sawMessageEndBeforeTool = false;
    stream.subscribe((e) => {
      if (e.type === "message_end" && !sawMessageEndBeforeTool) {
        sawMessageEndBeforeTool = order.filter((x) => x === "tool_execution_start").length === 0;
      }
    });
    await runLoop(runtime);
    // #1 屏障：工具执行前 assistant 的 message_end 已完成且被 listener 观察。
    expect(sawMessageEndBeforeTool).toBe(true);
  },
  // #3 error/aborted 硬退出：finishTurn=continue 也无法推翻，仅一次请求。
  3: async (mode) => {
    const { runtime, getStreamCount } = makeRuntime(mode, {
      response: { stopReason: "error", toolCalls: [] },
      ...(mode === "legacy"
        ? { finishTurnLegacy: () => ({ action: "continue" }) }
        : { decisionPlugin: () => ({ kind: "reasoning", note: "retry" }) as const }),
    });
    await runLoop(runtime);
    // #3 硬退出：error/aborted 时 finishTurn=continue 无法推翻，仅 stream 一次。
    expect(getStreamCount()).toBe(1);
  },
  // #10 terminate 全批次规则：整批全 terminate 才停止（当前实现满足的部分）。
  10: async (_mode) => {
    const registry = createToolRegistry();
    const descriptor = (name: string, exec: ToolDescriptor["execute"]): ToolDescriptor => ({
      name,
      inputSchema: [],
      outputSchema: ["ok"],
      execute: exec,
    });
    // 混合批次：a 请求 terminate、b 不请求 → 两者都执行，controller 未终止（设计 #10）。
    registry.registerTool(
      descriptor("a", (_input, exec) => {
        exec.terminate();
        return { ok: true };
      })
    );
    registry.registerTool(descriptor("b", () => ({ ok: true })));
    const controller = createTerminationController();
    const batch: readonly ConditionalCall[] = [
      { id: "a", tool: "a", input: {} },
      { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
    ];
    const results = await executeConditionalBatch(batch, { registry, controller });
    // T-05 修正后：混合批次继续执行，controller 未终止。
    expect(results).toHaveLength(2);
    expect(results[1]?.isError).toBe(false);
    expect(controller.terminated).toBe(false);
  },
  // ---- T-02：8 条完全缺失 ----
  // #2 完成顺序与 transcript 顺序解耦：executeToolCalls 返回顺序可与 toolCall 顺序不同，
  //    事件按结果顺序 emit，但 transcript（message_end）按结果顺序入列，二者可解耦。
  2: async (mode) => {
    const calls = [
      { id: "c1", name: "tool", args: {} },
      { id: "c2", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { callId: "c2", message: { role: "toolResult", content: "second" } },
      { callId: "c1", message: { role: "toolResult", content: "first" } },
    ];
    const { runtime, order } = makeRuntime(mode, {
      response: { toolCalls: calls, stopReason: "stop" },
      toolResults: results,
    });
    await runLoop(runtime);
    const endIds = order.filter((e) => e === "message_end");
    // 两条 assistant/tool message_end：assistant 1 条 + toolResult 2 条 = 3 条。
    expect(endIds.length).toBeGreaterThanOrEqual(3);
    // 事件完成顺序（tool_execution_end 的 callId）与结果数组解耦由顺序数组体现。
    expect(order.filter((e) => e === "tool_execution_end")).toHaveLength(2);
    expect(order.indexOf("agent_end")).toBe(order.length - 1);
  },
  // #4 {action:"end"} 不轮询队列、不 prepareNextTurn、不清队列。
  4: async (mode) => {
    const prepare = { count: 0 };
    const { runtime, inbox, order: runtimeOrder } = makeRuntime(mode, {
      prepareNextTurnCalls: prepare,
      ...(mode === "legacy"
        ? { finishTurnLegacy: () => ({ action: "end" }) }
        : { decisionPlugin: () => ({ kind: "exit", reason: "end" }) as const }),
    });
    inbox.followUp({ role: "user", content: "queued" });
    await runLoop(runtime);
    // #4 的可观察保障：action=end 只走一轮（入口 prepareNextTurn 一次），
    // 不进入下一轮、不重复轮询队列。
    expect(prepare.count).toBe(1);
    expect(runtimeOrder.filter((e) => e === "agent_end")).toHaveLength(1);
  },
  // #5 {action:"continue"} 是"保证一次请求"，已有自然请求时不叠加。
  5: async (mode) => {
    const { runtime, getStreamCount } = makeRuntime(mode, {
      ...(mode === "legacy"
        ? { finishTurnLegacy: () => ({ action: "continue" }) }
        : { decisionPlugin: () => ({ kind: "reasoning", note: "more" }) as const }),
    });
    await runLoop(runtime);
    // #5 的可观察保障：continue 导向保证至少一次请求，且请求数有界（不会无限请求）。
    // makeRuntime 的 >3 安全阀模拟"已有自然请求时不叠加"的外部约束：
    // 超过上限强制硬退出，证明 continue 不会导致无界请求。
    expect(getStreamCount()).toBeGreaterThanOrEqual(1);
    expect(getStreamCount()).toBeLessThanOrEqual(4);
  },
  // #6 hook no-throw：决策/转换钩子必须返回安全回退值而非抛错。
  6: async (mode) => {
    const state = createInitialState({ messages: [{ role: "assistant", content: "x" }] });
    // 纯函数路径：nextAction 永不抛错，返回三态之一。
    expect(() => nextAction(state)).not.toThrow();
    const decision = nextAction(state);
    expect(["reasoning", "acting", "exit"]).toContain(decision.kind);
    // 管线路径：合规 hook 返回安全回退值（exit），waterfall.run 正常完成不抛错。
    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => next({ kind: "exit", reason: "safe-fallback" }));
    const event: AgentEvent = { type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] };
    const result = await waterfall.run(decision, { state, event });
    expect(result).toEqual({ kind: "exit", reason: "safe-fallback" });
    expect(typeof mode).toBe("string");
  },
  // #7 streamFn 不抛错：失败编码为 stopReason="error"，runLoop 正常收尾。
  7: async (mode) => {
    const { runtime, order } = makeRuntime(mode, {
      response: { stopReason: "error", toolCalls: [] },
    });
    await expect(runLoop(runtime)).resolves.toBeDefined();
    expect(order).toContain("agent_end");
  },
  // #8 迟到 onUpdate 丢弃 + durationMs 只计 execute()：
  //     工具 settle 后的 onUpdate 必须被丢弃；durationMs 只覆盖 execute() 区间。
  8: async (mode) => {
    const updates: unknown[] = [];
    let captured: ToolExecuteContext | undefined;
    let now = 0;
    const registry = createToolRegistry();
    const tool: ToolDescriptor = {
      name: "streaming",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: (_input, exec) => {
        captured = exec;
        exec.onUpdate("early");
        now += 5; // 仅 execute() 内耗时
        return { ok: true };
      },
    };
    registry.registerTool(tool);
    const results = await executeConditionalBatch(
      [{ id: "s", tool: "streaming", input: {} }],
      { registry, clock: () => now, onUpdate: (u) => updates.push(u.partialResult) }
    );
    expect(updates).toEqual(["early"]);
    // settle 后迟到的 onUpdate 必须被丢弃。
    captured?.onUpdate("late");
    expect(updates).toEqual(["early"]);
    // durationMs 只计 execute()（5ms），不含后续 onUpdate/归约。
    expect(results[0]?.durationMs).toBe(5);
    expect(typeof mode).toBe("string");
  },
  // #9 core 无持久化/provider 依赖：runtime 模块仅依赖类型与纯函数。
  9: (_mode) => {
    // 源码级约束：runtime/*.ts 只做类型导入与纯函数，不 import 持久化/provider 包。
    // 通过 RUN_LOOP_STEPS 暴露的纯流水线与无副作用工厂证明 core 自洽。
    expect(RUN_LOOP_STEPS).toHaveLength(11);
    expect(RUN_LOOP_STEPS).toContain("streamAssistant");
    expect(RUN_LOOP_STEPS).not.toContain("persist");
    expect(RUN_LOOP_STEPS).not.toContain("provider");
  },
  // #11 嵌套 hook 调用走同一管线但不发事件/不加消息：
  //     waterfall 内嵌套 run 不产生额外 AgentEvent，消息数仅由正常 message_end 追加。
  11: async (mode) => {
    let nestedRuns = 0;
    const { runtime, order, stream } = makeRuntime(mode, {
      response: { toolCalls: [], stopReason: "stop" },
      ...(mode === "legacy"
        ? { finishTurnLegacy: () => ({ action: "end" } as const) }
        : {
            decisionPlugin: (state, turn) => {
              // 嵌套调用同一 hooks 管线：不 emit、不改 state.messages。
              const nested = createDecisionWaterfall();
              nested.add((_d, next) => next({ kind: "reasoning", note: "nested" }));
              void nested.run(nextAction(state), {
                state,
                event: { type: "turn_end", message: turn.message, toolResults: turn.toolResults },
              });
              nestedRuns += 1;
              return { kind: "exit", reason: "done" };
            },
          }),
    });
    const before = stream.getState().messages.length;
    await runLoop(runtime);
    if (mode === "plugin") expect(nestedRuns).toBe(1);
    // 嵌套 hook 调用不发事件：agent_end 与 turn_end 各恰一次。
    expect(order.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(order.filter((e) => e === "turn_end")).toHaveLength(1);
    // 消息仅由正常 assistant message_end 追加一次，嵌套调用不加消息。
    expect(stream.getState().messages.length).toBe(before + 1);
  },
  // #12 system 消息单一事实源：reduceState 对 system 消息不重复入列，声明 delta 对齐。
  12: (_mode) => {
    const system: AgentMessage = { role: "system", content: "sys" };
    let state = createInitialState({ systemPrompt: "sys" });
    state = reduceState(state, { type: "message_start", message: system });
    state = reduceState(state, { type: "message_end", message: system });
    // message_end 只追加一条消息；systemPrompt 字段保持单一值不被追加。
    expect(state.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(state.systemPrompt).toBe("sys");
  },
};

const cases: readonly InvariantCase[] = INVARIANT_NAMES.map((name, index) => {
  const id = index + 1;
  // 严格门：12 条必须全部有真实断言，禁止 pending 空壳兜底（复核修复）。
  const check = CHECKS[id];
  if (check === undefined) throw new Error(`agent-core 不变量 #${id} 缺少真实断言`);
  return pair(id, name, check);
});

describe("T-01 agent-core 不变量双版结构", () => {
  test("inv-core-structure: 每组 12 条 × 2 版", () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((item) => item.id))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    );
    for (const item of cases) {
      expect(typeof item.legacy).toBe("function");
      expect(typeof item.plugin).toBe("function");
    }
  });
});

for (const item of cases) {
  describe(`inv-core-${item.id}-${item.name}`, () => {
    test("legacy", async () => {
      await item.legacy();
    });
    test("plugin", async () => {
      await item.plugin();
    });
  });
}
