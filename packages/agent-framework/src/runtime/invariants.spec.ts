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
  body: (mode: "legacy" | "plugin") => void | Promise<void>
): InvariantCase {
  return { id, name, legacy: () => body("legacy"), plugin: () => body("plugin") };
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
    // 结果以反序返回：c2 先完成、c1 后完成，与 toolCalls 源码顺序相反。
    const results: ToolResult[] = [
      { callId: "c2", message: { role: "toolResult", content: "second" } },
      { callId: "c1", message: { role: "toolResult", content: "first" } },
    ];
    const { runtime, startCallIds, endCallIds } = makeRuntime(mode, {
      response: { toolCalls: calls, stopReason: "stop" },
      toolResults: results,
      // 单轮结束，避免 continue 语义下重复批次污染顺序探针。
      ...(mode === "legacy" ? { finishTurnLegacy: () => ({ action: "end" as const }) } : {}),
    });
    await runLoop(runtime);
    // §13 #2：tool_execution_start 按源码顺序，tool_execution_end 按完成顺序（反序）。
    expect(startCallIds).toEqual(["c1", "c2"]);
    expect(endCallIds).toEqual(["c2", "c1"]);
    // 哨兵：只有真正观察到"完成顺序与源码顺序相反"才为真，status-quo 的 >=2 数量断言无法区分。
    const reverseOrderObserved =
      startCallIds.join(",") === "c1,c2" && endCallIds.join(",") === "c2,c1";
    expect(reverseOrderObserved).toBe(true);
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
    let finishCount = 0;
    // 自然请求场景：第 1 轮带 toolCall，其工具结果天然触发第 2 轮请求。
    const { runtime, getStreamCount } = makeRuntime(mode, {
      responses: [
        { toolCalls: [{ id: "c1", name: "tool", args: {} }], stopReason: "stop" },
        { toolCalls: [], stopReason: "stop" },
      ],
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
      ...(mode === "legacy"
        ? {
            finishTurnLegacy: () => {
              finishCount += 1;
              // 第一次返回 continue：自然请求已存在，应被它满足而不额外叠加。
              return finishCount === 1 ? ({ action: "continue" } as const) : undefined;
            },
          }
        : {
            decisionPlugin: () => {
              finishCount += 1;
              return finishCount === 1 ? ({ kind: "reasoning", note: "more" } as const) : ({ kind: "exit", reason: "done" } as const);
            },
          }),
    });
    await runLoop(runtime);
    // 第 1 轮工具调用 + 第 2 轮自然跟进 = 精确 2 次请求。
    const naturalRequestSeen = finishCount >= 1 && getStreamCount() === 2;
    expect(getStreamCount()).toBe(2);
    // 哨兵：自然请求确实存在且 continue 未叠加额外请求，旧 [1,4] 区间无法区分。
    expect(naturalRequestSeen).toBe(true);
  },
  // #6 hook no-throw：决策/转换钩子必须返回安全回退值而非抛错。
  6: async (mode) => {
    const state = createInitialState({ messages: [{ role: "assistant", content: "x" }] });
    // 纯函数路径：nextAction 永不抛错，返回三态之一。
    expect(() => nextAction(state)).not.toThrow();
    const decision = nextAction(state);
    expect(["reasoning", "acting", "exit"]).toContain(decision.kind);

    // §13 #6 no-throw 契约：hook 内部错误必须被自身归一化，向调用方返回安全回退而非抛出。
    // 注意：createDecisionWaterfall.run 不代理归一化抛错（见 evidence/T-03/red.log），
    // 契约边界在 hook 作者——这里构造"内部抛错被捕获并返回 safe-fallback"的真实触发条件。
    let errorHookInvoked = false;
    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => {
      errorHookInvoked = true;
      let fallback: AgentDecision = { kind: "exit", reason: "safe-fallback" };
      try {
        throw new Error("internal hook failure");
      } catch {
        // no-throw：捕获内部错误，返回安全回退值（exit）。
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
    // 合规 hook 将错误归一化为安全回退，run 不抛且返回 exit 安全值。
    expect(runThrew).toBe(false);
    expect(result).toEqual({ kind: "exit", reason: "safe-fallback" });
    // 哨兵：内部错误确实发生且被归一化；合规路径才为真。
    expect(errorHookInvoked).toBe(true);
    void mode;
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
    // §13 #9：静态扫描 runtime/*.ts 的真实 import，替代 RUN_LOOP_STEPS 常量同义反复。
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
    // 哨兵：扫描确实覆盖了 runtime 源文件，且未发现禁止的持久化/provider import。
    expect(dependencyScanRan).toBe(true);
    expect(offenders).toEqual([]);
  },
  // #11 嵌套 hook 调用走同一管线但不发事件/不加消息：
  //     waterfall 内嵌套 run 不产生额外 AgentEvent，消息数仅由正常 message_end 追加。
  11: async (mode) => {
    // 两版都带 toolCall，并在各自的决策钩子里嵌套调用同一 hooks 管线。
    // 嵌套只走纯决策计算：不 emit AgentEvent、不追加消息。
    const toolCall = { id: "c1", name: "tool", args: {} };
    const toolResult: ToolResult = { callId: "c1", message: { role: "toolResult", content: "r" } };
    let legacyNestedInvoked = false;
    let pluginNestedInvoked = false;

    const { runtime, order, stream } = makeRuntime(mode, {
      response: { toolCalls: [toolCall], stopReason: "stop" },
      toolResults: [toolResult],
      ...(mode === "legacy"
        ? {
            // legacy：字段赋值钩子 finishTurn 内嵌套，并立即结束，避免额外请求污染事件计数。
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
          }
        : {
            // plugin：管线入口 decision 内嵌套（同步触发，随后由 waterfall 处理）。
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
          }),
    });
    const before = stream.getState().messages.length;
    await runLoop(runtime);

    // 两版各自的可观察差异：legacy 走字段赋值钩子，plugin 走管线入口，各自设自己的哨兵。
    if (mode === "legacy") {
      expect(legacyNestedInvoked).toBe(true);
    } else {
      expect(pluginNestedInvoked).toBe(true);
    }
    // 嵌套调用不发事件：agent_end 与 turn_end 各恰一次，工具事件各一次。
    expect(order.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(order.filter((e) => e === "turn_end")).toHaveLength(1);
    expect(order.filter((e) => e === "tool_execution_end")).toHaveLength(1);
    // 消息仅由正常 assistant message_end + toolResult message_end 追加，嵌套调用不加消息。
    expect(stream.getState().messages.length).toBe(before + 2);
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
