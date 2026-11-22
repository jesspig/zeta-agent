import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createDecisionWaterfall, nextAction, type AgentDecision } from "./decision";
import { createInitialState, reduceState } from "./agent";
import { executeConditionalBatch, type ConditionalCall } from "../tools/parallel";
import {
  createTerminationController,
  createToolRegistry,
  type ToolDescriptor,
  type ToolExecuteContext,
} from "../tools/pipeline";

/**
 * agent-core 12 条不变量等价测试（state-and-events.md §13 / 基线约定 §9）。
 *
 * 与 tools/invariants.spec.ts 的工具流水线 12 条（inv-tool-）严格区分：
 * 本文件覆盖 agent-core 的 12 条，测试名统一使用 inv-core- 前缀。
 * 每条不变量提供 legacy（字段赋值 hook）与 plugin（管线 hook）两版独立断言。
 *
 * CR-39 修复：两版各自构造本版 runtime、各自内联行为断言与接线哨兵，
 * 不再共享 CHECKS 条目，也不通过 check(mode) 委托（见 T-03 结构门）。
 */

interface InvariantCase {
  readonly id: number;
  readonly name: string;
  /** 两版独立的断言体：各自构造接线、各自设哨兵、各自内联全部行为断言。 */
  readonly legacy: () => void | Promise<void>;
  readonly plugin: () => void | Promise<void>;
}

/** 运行时构造选项：覆盖各不变量所需的钩子与响应。 */
interface RuntimeOptions {
  readonly response?: Partial<AssistantResult>;
  /** 按轮次覆盖响应：索引 i 对应第 i+1 次 streamAssistant，缺省沿用 response。 */
  readonly responses?: readonly Partial<AssistantResult>[];
  readonly toolResults?: readonly ToolResult[];
  readonly finishTurnLegacy?: (turn: LastTurn) => { action: "continue" | "end" } | undefined;
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
  const startCallIds: string[] = [];
  const endCallIds: string[] = [];
  stream.subscribe((event: AgentEvent) => {
    order.push(event.type);
    // tool_execution_start 按 toolCalls 源码顺序 emit；end 按结果完成顺序 emit。
    if (event.type === "tool_execution_start") startCallIds.push(event.toolCallId);
    if (event.type === "tool_execution_end") endCallIds.push(event.toolCallId);
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
      const override = options.responses?.[streamCount - 1];
      return override === undefined ? response : { ...response, ...override };
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
    startCallIds,
    endCallIds,
    getRequestCount: () => requestCount,
    getStreamCount: () => streamCount,
  };
}

function pair(
  id: number,
  name: string,
  legacy: () => void | Promise<void>,
  plugin: () => void | Promise<void>
): InvariantCase {
  return { id, name, legacy, plugin };
}

/**
 * §13 要点映射表（门 2 数据源；scripts/check-invariant-points.mjs 机械校验）。
 * keywords 取每条测试要点中可区分正确/错误实现的词，断言块需含哨兵与关键词。
 */
export const INVARIANT_TEST_POINTS: Record<
  number,
  { readonly point: string; readonly keywords: readonly string[]; readonly assertFragment: string }
> = {
  1: { point: "assistant message_end 屏障", keywords: ["message_end", "preflight", "barrier"], assertFragment: "sawMessageEndBeforeTool" },
  2: { point: "完成顺序 vs 源码顺序解耦", keywords: ["tool_execution_end", "callId", "reverse"], assertFragment: "reverseOrderObserved" },
  3: { point: "error/aborted 硬退出", keywords: ["stopReason", "error", "continue"], assertFragment: "hardExitObserved" },
  4: { point: "end 不清队列", keywords: ["prepareNextTurn", "queue", "agent_end"], assertFragment: "endKeepsQueueObserved" },
  5: { point: "continue 保证一次请求", keywords: ["streamCount", "naturalRequest", "continue"], assertFragment: "naturalRequestSeen" },
  6: { point: "hook no-throw", keywords: ["throw", "waterfall", "safe-fallback"], assertFragment: "errorHookInvoked" },
  7: { point: "streamFn 不抛错", keywords: ["streamAssistant", "error", "agent_end"], assertFragment: "streamErrorObserved" },
  8: { point: "迟到 onUpdate 丢弃 + durationMs 边界", keywords: ["onUpdate", "durationMs", "settle"], assertFragment: "lateUpdateObserved" },
  9: { point: "core 无持久化/provider 依赖", keywords: ["import", "runtime", "dependency"], assertFragment: "dependencyScanRan" },
  10: { point: "terminate 全批次规则", keywords: ["terminate", "batch", "controller"], assertFragment: "mixedBatchObserved" },
  11: { point: "runToolCall 走 hooks 无事件", keywords: ["nested", "toolCall", "event"], assertFragment: "legacyNestedInvoked" },
  12: { point: "system 消息单一事实源", keywords: ["system", "delta", "single-source"], assertFragment: "singleSourceVerified" },
};

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

/**
 * 接线哨兵：验证本版钩子确被 runLoop 读取。
 * legacy 走字段赋值 finishTurn；plugin 走管线入口 decision。两者不共用断言体。
 */
async function legacyHookProbe(): Promise<boolean> {
  let invoked = false;
  const { runtime } = makeRuntime("legacy", {
    finishTurnLegacy: (turn) => {
      invoked = turn.message.role === "assistant";
      return { action: "end" };
    },
  });
  await runLoop(runtime);
  return invoked;
}

async function pluginHookProbe(): Promise<boolean> {
  let invoked = false;
  const { runtime } = makeRuntime("plugin", {
    decisionPlugin: () => {
      invoked = true;
      return { kind: "exit", reason: "dual-version-probe" };
    },
  });
  await runLoop(runtime);
  return invoked;
}

/**
 * 12 条 × 2 版完全独立的行为断言（CR-39 修复后不再共享 CHECKS）。
 * 每版各自构造本版 runtime、内联行为断言与关键哨兵，末尾再断言本版接线被读取。
 */
const cases: readonly InvariantCase[] = [
  // #1 message-end 屏障
  pair(1, INVARIANT_NAMES[0], async () => {
    const { runtime, order, stream } = makeRuntime("legacy", {
      response: { toolCalls: [{ id: "c1", name: "tool", args: {} }], stopReason: "stop" },
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
    });
    let sawMessageEndBeforeTool = false;
    stream.subscribe((e) => {
      if (e.type === "message_end" && !sawMessageEndBeforeTool) {
        sawMessageEndBeforeTool = order.filter((x) => x === "tool_execution_start").length === 0;
      }
    });
    await runLoop(runtime);
    expect(sawMessageEndBeforeTool).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const { runtime, order, stream } = makeRuntime("plugin", {
      response: { toolCalls: [{ id: "c1", name: "tool", args: {} }], stopReason: "stop" },
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
    });
    let sawMessageEndBeforeTool = false;
    stream.subscribe((e) => {
      if (e.type === "message_end" && !sawMessageEndBeforeTool) {
        sawMessageEndBeforeTool = order.filter((x) => x === "tool_execution_start").length === 0;
      }
    });
    await runLoop(runtime);
    expect(sawMessageEndBeforeTool).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #2 完成顺序与 transcript 顺序解耦
  pair(2, INVARIANT_NAMES[1], async () => {
    const calls = [
      { id: "c1", name: "tool", args: {} },
      { id: "c2", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { callId: "c2", message: { role: "toolResult", content: "second" } },
      { callId: "c1", message: { role: "toolResult", content: "first" } },
    ];
    const { runtime, startCallIds, endCallIds } = makeRuntime("legacy", {
      response: { toolCalls: calls, stopReason: "stop" },
      toolResults: results,
      finishTurnLegacy: () => ({ action: "end" as const }),
    });
    await runLoop(runtime);
    expect(startCallIds).toEqual(["c1", "c2"]);
    expect(endCallIds).toEqual(["c2", "c1"]);
    const reverseOrderObserved =
      startCallIds.join(",") === "c1,c2" && endCallIds.join(",") === "c2,c1";
    expect(reverseOrderObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const calls = [
      { id: "c1", name: "tool", args: {} },
      { id: "c2", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { callId: "c2", message: { role: "toolResult", content: "second" } },
      { callId: "c1", message: { role: "toolResult", content: "first" } },
    ];
    const { runtime, startCallIds, endCallIds } = makeRuntime("plugin", {
      response: { toolCalls: calls, stopReason: "stop" },
      toolResults: results,
    });
    await runLoop(runtime);
    expect(startCallIds).toEqual(["c1", "c2"]);
    expect(endCallIds).toEqual(["c2", "c1"]);
    const reverseOrderObserved =
      startCallIds.join(",") === "c1,c2" && endCallIds.join(",") === "c2,c1";
    expect(reverseOrderObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #3 error/aborted 硬退出
  pair(3, INVARIANT_NAMES[2], async () => {
    const { runtime, getStreamCount } = makeRuntime("legacy", {
      response: { stopReason: "error", toolCalls: [] },
      finishTurnLegacy: () => ({ action: "continue" }),
    });
    await runLoop(runtime);
    const hardExitObserved = getStreamCount() === 1;
    expect(getStreamCount()).toBe(1);
    expect(hardExitObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const { runtime, getStreamCount } = makeRuntime("plugin", {
      response: { stopReason: "error", toolCalls: [] },
      decisionPlugin: () => ({ kind: "reasoning", note: "retry" }) as const,
    });
    await runLoop(runtime);
    const hardExitObserved = getStreamCount() === 1;
    expect(getStreamCount()).toBe(1);
    expect(hardExitObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #4 {action:"end"} 不轮询队列、不 prepareNextTurn、不清队列
  pair(4, INVARIANT_NAMES[3], async () => {
    const prepare = { count: 0 };
    const { runtime, inbox, order: runtimeOrder } = makeRuntime("legacy", {
      prepareNextTurnCalls: prepare,
      finishTurnLegacy: () => ({ action: "end" }),
    });
    inbox.followUp({ role: "user", content: "queued" });
    await runLoop(runtime);
    const endKeepsQueueObserved =
      prepare.count === 1 && runtimeOrder.filter((e) => e === "agent_end").length === 1;
    expect(prepare.count).toBe(1);
    expect(runtimeOrder.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(endKeepsQueueObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const prepare = { count: 0 };
    const { runtime, inbox, order: runtimeOrder } = makeRuntime("plugin", {
      prepareNextTurnCalls: prepare,
      decisionPlugin: () => ({ kind: "exit", reason: "end" }) as const,
    });
    inbox.followUp({ role: "user", content: "queued" });
    await runLoop(runtime);
    const endKeepsQueueObserved =
      prepare.count === 1 && runtimeOrder.filter((e) => e === "agent_end").length === 1;
    expect(prepare.count).toBe(1);
    expect(runtimeOrder.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(endKeepsQueueObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #5 {action:"continue"} 是"保证一次请求"，已有自然请求时不叠加
  pair(5, INVARIANT_NAMES[4], async () => {
    let finishCount = 0;
    const { runtime, getStreamCount } = makeRuntime("legacy", {
      responses: [
        { toolCalls: [{ id: "c1", name: "tool", args: {} }], stopReason: "stop" },
        { toolCalls: [], stopReason: "stop" },
      ],
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
      finishTurnLegacy: () => {
        finishCount += 1;
        return finishCount === 1 ? ({ action: "continue" } as const) : undefined;
      },
    });
    await runLoop(runtime);
    const naturalRequestSeen = finishCount >= 1 && getStreamCount() === 2;
    expect(getStreamCount()).toBe(2);
    expect(naturalRequestSeen).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    let finishCount = 0;
    const { runtime, getStreamCount } = makeRuntime("plugin", {
      responses: [
        { toolCalls: [{ id: "c1", name: "tool", args: {} }], stopReason: "stop" },
        { toolCalls: [], stopReason: "stop" },
      ],
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
      decisionPlugin: () => {
        finishCount += 1;
        return finishCount === 1 ? ({ kind: "reasoning", note: "more" } as const) : ({ kind: "exit", reason: "done" } as const);
      },
    });
    await runLoop(runtime);
    const naturalRequestSeen = finishCount >= 1 && getStreamCount() === 2;
    expect(getStreamCount()).toBe(2);
    expect(naturalRequestSeen).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #6 hook no-throw：决策/转换钩子必须返回安全回退值而非抛错
  pair(6, INVARIANT_NAMES[5], async () => {
    const state = createInitialState({ messages: [{ role: "assistant", content: "x" }] });
    expect(() => nextAction(state)).not.toThrow();
    const decision = nextAction(state);
    expect(["reasoning", "acting", "exit"]).toContain(decision.kind);
    let errorHookInvoked = false;
    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => {
      errorHookInvoked = true;
      let fallback: AgentDecision = { kind: "exit", reason: "safe-fallback" };
      try {
        throw new Error("internal hook failure");
      } catch {
        fallback = { kind: "exit", reason: "safe-fallback" };
      }
      next(fallback);
    });
    const event: AgentEvent = { type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] };
    let runThrew = false;
    let result: unknown;
    try {
      result = await waterfall.run(decision, { state, event });
    } catch {
      runThrew = true;
    }
    expect(runThrew).toBe(false);
    expect(result).toEqual({ kind: "exit", reason: "safe-fallback" });
    expect(errorHookInvoked).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const state = createInitialState({ messages: [{ role: "assistant", content: "x" }] });
    expect(() => nextAction(state)).not.toThrow();
    const decision = nextAction(state);
    expect(["reasoning", "acting", "exit"]).toContain(decision.kind);
    let errorHookInvoked = false;
    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => {
      errorHookInvoked = true;
      let fallback: AgentDecision = { kind: "exit", reason: "safe-fallback" };
      try {
        throw new Error("internal hook failure");
      } catch {
        fallback = { kind: "exit", reason: "safe-fallback" };
      }
      next(fallback);
    });
    const event: AgentEvent = { type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] };
    let runThrew = false;
    let result: unknown;
    try {
      result = await waterfall.run(decision, { state, event });
    } catch {
      runThrew = true;
    }
    expect(runThrew).toBe(false);
    expect(result).toEqual({ kind: "exit", reason: "safe-fallback" });
    expect(errorHookInvoked).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #7 streamFn 不抛错：失败编码为 stopReason="error"，runLoop 正常收尾
  pair(7, INVARIANT_NAMES[6], async () => {
    const { runtime, order } = makeRuntime("legacy", {
      response: { stopReason: "error", toolCalls: [] },
    });
    await expect(runLoop(runtime)).resolves.toBeDefined();
    const streamErrorObserved = order.includes("agent_end");
    expect(order).toContain("agent_end");
    expect(streamErrorObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const { runtime, order } = makeRuntime("plugin", {
      response: { stopReason: "error", toolCalls: [] },
    });
    await expect(runLoop(runtime)).resolves.toBeDefined();
    const streamErrorObserved = order.includes("agent_end");
    expect(order).toContain("agent_end");
    expect(streamErrorObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #8 迟到 onUpdate 丢弃 + durationMs 只计 execute()
  pair(8, INVARIANT_NAMES[7], async () => {
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
        now += 5;
        return { ok: true };
      },
    };
    registry.registerTool(tool);
    const results = await executeConditionalBatch(
      [{ id: "s", tool: "streaming", input: {} }],
      { registry, clock: () => now, onUpdate: (u) => updates.push(u.partialResult) }
    );
    expect(updates).toEqual(["early"]);
    captured?.onUpdate("late");
    const lateUpdateObserved = updates.length === 1 && updates[0] === "early";
    expect(updates).toEqual(["early"]);
    expect(results[0]?.durationMs).toBe(5);
    expect(lateUpdateObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
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
        now += 5;
        return { ok: true };
      },
    };
    registry.registerTool(tool);
    const results = await executeConditionalBatch(
      [{ id: "s", tool: "streaming", input: {} }],
      { registry, clock: () => now, onUpdate: (u) => updates.push(u.partialResult) }
    );
    expect(updates).toEqual(["early"]);
    captured?.onUpdate("late");
    const lateUpdateObserved = updates.length === 1 && updates[0] === "early";
    expect(updates).toEqual(["early"]);
    expect(results[0]?.durationMs).toBe(5);
    expect(lateUpdateObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #9 core 无持久化/provider 依赖
  pair(9, INVARIANT_NAMES[8], async () => {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(runtimeDir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".spec.ts"));
    const forbidden = /(?:@zeta-agent\/)?(?:deploy|session-persistence|persistence|provider(?:s)?)(?:\/|["']|$)/;
    const offenders: string[] = [];
    let dependencyScanRan = false;
    for (const name of files) {
      const source = readFileSync(join(runtimeDir, name), "utf8");
      for (const line of source.split(/\r?\n/)) {
        dependencyScanRan = true;
        const match = /^\s*(?:import|export)\s+(?!type\b).*?from\s*["']([^"']+)["']/.exec(line);
        const bare = /^\s*import\s*["']([^"']+)["']/.exec(line);
        const spec = match?.[1] ?? bare?.[1];
        if (spec !== undefined && forbidden.test(spec)) offenders.push(`${name}: ${spec}`);
      }
    }
    expect(dependencyScanRan).toBe(true);
    expect(offenders).toEqual([]);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(runtimeDir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".spec.ts"));
    const forbidden = /(?:@zeta-agent\/)?(?:deploy|session-persistence|persistence|provider(?:s)?)(?:\/|["']|$)/;
    const offenders: string[] = [];
    let dependencyScanRan = false;
    for (const name of files) {
      const source = readFileSync(join(runtimeDir, name), "utf8");
      for (const line of source.split(/\r?\n/)) {
        dependencyScanRan = true;
        const match = /^\s*(?:import|export)\s+(?!type\b).*?from\s*["']([^"']+)["']/.exec(line);
        const bare = /^\s*import\s*["']([^"']+)["']/.exec(line);
        const spec = match?.[1] ?? bare?.[1];
        if (spec !== undefined && forbidden.test(spec)) offenders.push(`${name}: ${spec}`);
      }
    }
    expect(dependencyScanRan).toBe(true);
    expect(offenders).toEqual([]);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #10 terminate 全批次规则
  pair(10, INVARIANT_NAMES[9], async () => {
    const registry = createToolRegistry();
    const descriptor = (name: string, exec: ToolDescriptor["execute"]): ToolDescriptor => ({
      name,
      inputSchema: [],
      outputSchema: ["ok"],
      execute: exec,
    });
    registry.registerTool(descriptor("a", (_input, exec) => {
      exec.terminate();
      return { ok: true };
    }));
    registry.registerTool(descriptor("b", () => ({ ok: true })));
    const controller = createTerminationController();
    const batch: readonly ConditionalCall[] = [
      { id: "a", tool: "a", input: {} },
      { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
    ];
    const results = await executeConditionalBatch(batch, { registry, controller });
    const mixedBatchObserved =
      results.length === 2 && results[1]?.isError === false && controller.terminated === false;
    expect(results).toHaveLength(2);
    expect(results[1]?.isError).toBe(false);
    expect(controller.terminated).toBe(false);
    expect(mixedBatchObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const registry = createToolRegistry();
    const descriptor = (name: string, exec: ToolDescriptor["execute"]): ToolDescriptor => ({
      name,
      inputSchema: [],
      outputSchema: ["ok"],
      execute: exec,
    });
    registry.registerTool(descriptor("a", (_input, exec) => {
      exec.terminate();
      return { ok: true };
    }));
    registry.registerTool(descriptor("b", () => ({ ok: true })));
    const controller = createTerminationController();
    const batch: readonly ConditionalCall[] = [
      { id: "a", tool: "a", input: {} },
      { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
    ];
    const results = await executeConditionalBatch(batch, { registry, controller });
    const mixedBatchObserved =
      results.length === 2 && results[1]?.isError === false && controller.terminated === false;
    expect(results).toHaveLength(2);
    expect(results[1]?.isError).toBe(false);
    expect(controller.terminated).toBe(false);
    expect(mixedBatchObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #11 嵌套 hook 调用走同一管线但不发事件/不加消息
  pair(11, INVARIANT_NAMES[10], async () => {
    const toolCall = { id: "c1", name: "tool", args: {} };
    const toolResult: ToolResult = { callId: "c1", message: { role: "toolResult", content: "r" } };
    let legacyNestedInvoked = false;
    const { runtime, order, stream } = makeRuntime("legacy", {
      response: { toolCalls: [toolCall], stopReason: "stop" },
      toolResults: [toolResult],
      finishTurnLegacy: (turn) => {
        const nested = createDecisionWaterfall();
        nested.add((_d, next) => next({ kind: "reasoning", note: "nested-with-toolCall" }));
        void nested.run(nextAction(stream.getState()), {
          state: stream.getState(),
          event: { type: "turn_end", message: turn.message, toolResults: turn.toolResults },
        });
        legacyNestedInvoked = true;
        return { action: "end" };
      },
    });
    const before = stream.getState().messages.length;
    await runLoop(runtime);
    expect(legacyNestedInvoked).toBe(true);
    expect(order.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(order.filter((e) => e === "turn_end")).toHaveLength(1);
    expect(order.filter((e) => e === "tool_execution_end")).toHaveLength(1);
    expect(stream.getState().messages.length).toBe(before + 2);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const toolCall = { id: "c1", name: "tool", args: {} };
    const toolResult: ToolResult = { callId: "c1", message: { role: "toolResult", content: "r" } };
    let pluginNestedInvoked = false;
    const { runtime, order, stream } = makeRuntime("plugin", {
      response: { toolCalls: [toolCall], stopReason: "stop" },
      toolResults: [toolResult],
      decisionPlugin: (state, turn) => {
        const nested = createDecisionWaterfall();
        nested.add((_d, next) => next({ kind: "reasoning", note: "nested-with-toolCall" }));
        void nested.run(nextAction(state), {
          state,
          event: { type: "turn_end", message: turn.message, toolResults: turn.toolResults },
        });
        pluginNestedInvoked = true;
        return { kind: "exit", reason: "done" };
      },
    });
    const before = stream.getState().messages.length;
    await runLoop(runtime);
    expect(pluginNestedInvoked).toBe(true);
    expect(order.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(order.filter((e) => e === "turn_end")).toHaveLength(1);
    expect(order.filter((e) => e === "tool_execution_end")).toHaveLength(1);
    expect(stream.getState().messages.length).toBe(before + 2);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #12 system 消息单一事实源
  pair(12, INVARIANT_NAMES[11], async () => {
    const authoritative = "sys (tools: read,write)";
    let state = createInitialState({ systemPrompt: authoritative });
    const startedFromSingleSource = state.messages.length === 0;
    expect(startedFromSingleSource).toBe(true);
    const declare = (prompt: string): AgentMessage => ({ role: "system", content: prompt });
    state = reduceState(state, { type: "message_start", message: declare(state.systemPrompt) });
    state = reduceState(state, { type: "message_end", message: declare(state.systemPrompt) });
    const systems = state.messages.filter((m) => m.role === "system");
    const deltaAligned = systems.length === 1 && String(systems[0]?.content) === authoritative;
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toBe(state.systemPrompt);
    expect(state.systemPrompt).toBe(authoritative);
    const singleSourceVerified = startedFromSingleSource && deltaAligned && systems.length === 1;
    expect(singleSourceVerified).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const authoritative = "sys (tools: read,write)";
    let state = createInitialState({ systemPrompt: authoritative });
    const startedFromSingleSource = state.messages.length === 0;
    expect(startedFromSingleSource).toBe(true);
    const declare = (prompt: string): AgentMessage => ({ role: "system", content: prompt });
    state = reduceState(state, { type: "message_start", message: declare(state.systemPrompt) });
    state = reduceState(state, { type: "message_end", message: declare(state.systemPrompt) });
    const systems = state.messages.filter((m) => m.role === "system");
    const deltaAligned = systems.length === 1 && String(systems[0]?.content) === authoritative;
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toBe(state.systemPrompt);
    expect(state.systemPrompt).toBe(authoritative);
    const singleSourceVerified = startedFromSingleSource && deltaAligned && systems.length === 1;
    expect(singleSourceVerified).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),
];

describe("T-01 agent-core 不变量双版结构", () => {
  test("inv-core-structure: 每组 12 条 × 2 版，且两版断言体互不共享", () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((item) => item.id))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    );
    for (const item of cases) {
      expect(typeof item.legacy).toBe("function");
      expect(typeof item.plugin).toBe("function");
      // 双版独立门：legacy/plugin 必须是不同的函数引用，禁止共享 body 凑数。
      expect(item.legacy).not.toBe(item.plugin);
    }
  });
});

// CR-39 修复的结构门（RED→GREEN）：
// finding 批评"两版都调用同一 CHECKS 条目 await check(mode)，不同包装函数不证明行为独立"。
// 该门要求两版断言体各自内联行为断言（含 expect），不再委托共享的 check(mode)。
describe("T-03 CR-39 两版断言独立性", () => {
  test("inv-core-independent: 两版断言体各自内联断言，不共享 check(mode) 委托", () => {
    for (const item of cases) {
      const legacySrc = item.legacy.toString();
      const pluginSrc = item.plugin.toString();
      expect(legacySrc).not.toMatch(/check\(mode\)/);
      expect(pluginSrc).not.toMatch(/check\(mode\)/);
      // 两版断言体各自内联 expect，行为断言不被委托。
      expect(legacySrc).toContain("expect(");
      expect(pluginSrc).toContain("expect(");
      // 两版函数引用不同（不得为同一对象）。
      expect(item.legacy).not.toBe(item.plugin);
      // 两版各自调用本版接线哨兵，不交叉。
      expect(legacySrc).toContain("legacyHookProbe");
      expect(pluginSrc).toContain("pluginHookProbe");
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
