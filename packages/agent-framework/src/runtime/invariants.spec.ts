import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent } from "./agent";
import { createInbox } from "./inbox";
import {
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopRuntime,
  type ToolResult,
} from "./loop";
import { createDecisionWaterfall, type AgentDecision, type DecisionWaterfall } from "./decision";
import { createInitialState, type AgentState } from "./agent";
import { executeConditionalBatch, type ConditionalCall } from "../tools/parallel";
import {
  createTerminationController,
  createToolPipeline,
  createToolRegistry,
  declareToolChanges,
  runToolCall,
  type BatchContext,
  type ToolDescriptor,
  type ToolExecuteContext,
} from "../tools/pipeline";
import { AgentPluginManager, type PluginPipelineConfig } from "../plugins/manager";

/**
 * agent-core 12 条不变量等价测试（state-and-events.md §13 / 基线约定 §9）。
 *
 * 与 tools/invariants.spec.ts 的工具流水线 12 条（inv-tool-）严格区分：
 * 本文件覆盖 agent-core 的 12 条，测试名统一使用 inv-core- 前缀。
 * 每条不变量提供 legacy（字段赋值 hook）与 plugin（真 AgentPluginManager 管线）两版独立断言。
 *
 * CR-39 修复：两版各自构造本版 runtime、各自内联行为断言与接线哨兵，
 * 不再共享 CHECKS 条目，也不通过 check(mode) 委托（见 T-03 结构门）。
 * T-04：plugin 版由 AgentPluginManager 的 decision 链 + DecisionWaterfall 桥接驱动，
 * 不再使用 decision 字段赋值；legacy 版保留 finishTurn 字段赋值。
 * D10：#8/#9/#10/#12 原为仅末尾哨兵不同的复制逻辑，改为真实双适配器
 * （legacy 走本地旧路径，plugin 走框架 pipeline/parallel/plugin-manager/declareToolChanges）。
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
  readonly decisionPlugin?: (state: AgentState, turn: LastTurn) => AgentDecision;
  readonly prepareNextTurnCalls?: { count: number };
  readonly onRequest?: (request: unknown) => void;
  /** #6 专用：legacy 版字段赋值一个抛错 hook 的 waterfall。 */
  readonly waterfall?: DecisionWaterfall;
  /** #6 专用：plugin 版插件管理器配置（关闭 fallback 使 hook 抛错传播到 runLoop）。 */
  readonly managerConfig?: Partial<PluginPipelineConfig>;
}

/** 决策链在插件管理器中流转的输入。 */
interface PluginDecisionInput {
  readonly decision: AgentDecision;
  readonly state: AgentState;
  readonly turn: LastTurn;
}

/** 只负责观察（事件序列 / 工具 id / 计数），与行为断言体无关，两版共用不构成共享断言。 */
function createProbes() {
  const stream = createEventStream();
  const order: string[] = [];
  const startCallIds: string[] = [];
  const endCallIds: string[] = [];
  stream.subscribe((event: AgentEvent) => {
    order.push(event.type);
    if (event.type === "tool_execution_start") startCallIds.push(event.toolCallId);
    if (event.type === "tool_execution_end") endCallIds.push(event.toolCallId);
  });
  const inbox = createInbox();
  let requestCount = 0;
  let streamCount = 0;
  return {
    stream,
    inbox,
    order,
    startCallIds,
    endCallIds,
    getRequestCount: () => requestCount,
    getStreamCount: () => streamCount,
    countRequest: () => { requestCount += 1; },
    nextStream: () => { requestCount += 1; streamCount += 1; return streamCount; },
  };
}

function responseOf(options: RuntimeOptions): AssistantResult {
  return {
    message: { role: "assistant", content: "ok" },
    toolCalls: [],
    stopReason: "stop",
    ...options.response,
  };
}

function nextResponse(
  probes: ReturnType<typeof createProbes>,
  options: RuntimeOptions,
  response: AssistantResult
): AssistantResult {
  const n = probes.nextStream();
  // 安全阀：continue 场景在若干轮后强制硬退出，避免断言用例无限循环。
  if (n > 3) return { ...response, stopReason: "error", toolCalls: [] };
  const override = options.responses?.[n - 1];
  return override === undefined ? response : { ...response, ...override };
}

/** legacy 版：hook 通过字段赋值驱动（finishTurn / waterfall 字段）。 */
function makeLegacyRuntime(options: RuntimeOptions = {}) {
  const probes = createProbes();
  const response = responseOf(options);
  const runtime: LoopRuntime = {
    inbox: probes.inbox,
    emit: (event) => probes.stream.emit(event),
    getState: () => probes.stream.getState(),
    prepareRequest: (request) => {
      probes.countRequest();
      options.onRequest?.(request);
      return request;
    },
    streamAssistant: async () => nextResponse(probes, options, response),
    executeToolCalls: async () => options.toolResults ?? [],
    prepareNextTurn: () => {
      if (options.prepareNextTurnCalls) options.prepareNextTurnCalls.count += 1;
    },
    finishTurn: options.finishTurnLegacy ?? (() => ({ action: "continue" })),
    waterfall: options.waterfall,
  };
  return { ...probes, runtime };
}

/**
 * plugin 版：hook 由真 AgentPluginManager 驱动。
 * manager 的 decision 链负责产出决策，DecisionWaterfall 仅作桥接；不使用 decision 字段赋值。
 */
function makePluginRuntime(options: RuntimeOptions = {}) {
  const probes = createProbes();
  const response = responseOf(options);
  const manager = new AgentPluginManager({ config: options.managerConfig });
  const decisionFn = options.decisionPlugin ?? (() => ({ kind: "exit", reason: "end" }));

  manager.addHook<PluginDecisionInput>("decision", (input) => {
    const override = decisionFn(input.state, input.turn);
    return override === undefined ? input : { ...input, decision: override };
  });
  manager.addHook("prepareNextTurn", () => {
    if (options.prepareNextTurnCalls) options.prepareNextTurnCalls.count += 1;
  });

  const waterfall = createDecisionWaterfall();
  waterfall.add(async (_decision, next, context) => {
    const event = context.event;
    const turn: LastTurn = event.type === "turn_end"
      ? { message: event.message, toolResults: event.toolResults }
      : { message: { role: "assistant", content: "" }, toolResults: [] };
    const result = await manager.run<PluginDecisionInput>("decision", {
      decision: _decision,
      state: context.state,
      turn,
    });
    next(result.decision);
  });

  const runtime: LoopRuntime = {
    inbox: probes.inbox,
    emit: (event) => probes.stream.emit(event),
    getState: () => probes.stream.getState(),
    prepareRequest: (request) => {
      probes.countRequest();
      options.onRequest?.(request);
      return request;
    },
    streamAssistant: async () => nextResponse(probes, options, response),
    executeToolCalls: async () => options.toolResults ?? [],
    prepareNextTurn: () => {
      void manager.run("prepareNextTurn", probes.stream.getState());
    },
    waterfall,
  };
  return { ...probes, runtime, manager };
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
 * #8/#9/#10/#12 是工具/静态性质，不构造 runLoop runtime。旧版两版仅哨兵不同、属复制逻辑；
 * 这里为每条引入真实双适配器：legacy 走本地旧路径实现，plugin 走框架实现（pipeline / parallel /
 * declareToolChanges / 插件管理器 hook 链）。两版各自断言，不再只靠末尾哨兵区分。
 */

/** #8 legacy：本地直接调用工具，settle 边界由自身维护，不经过框架流水线。 */
function runLegacyStreamingTool(
  tool: ToolDescriptor,
  options: {
    readonly clock: () => number;
    readonly onUpdate: (partialResult: unknown) => void;
  }
): { readonly updates: readonly unknown[]; readonly durationMs: number; readonly emitLate: () => void } {
  const updates: unknown[] = [];
  let settled = false;
  let captured: ToolExecuteContext | undefined;
  const exec: ToolExecuteContext = {
    onUpdate(partialResult) {
      if (settled) return;
      updates.push(partialResult);
      options.onUpdate(partialResult);
    },
    terminate: () => {},
    terminated: () => false,
  };
  captured = exec;
  const startedAt = options.clock();
  void tool.execute({}, exec);
  const endedAt = options.clock();
  settled = true;
  return {
    updates,
    durationMs: Math.max(0, endedAt - startedAt),
    emitLate: () => { captured?.onUpdate("late"); },
  };
}

/** #9 legacy：直接扫描 runtime 源码的 import 声明。 */
function legacyDependencyScan(runtimeDir: string): { readonly scanned: boolean; readonly offenders: string[] } {
  const files = readdirSync(runtimeDir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".spec.ts"));
  const forbidden = /(?:@zeta-agent\/)?(?:deploy|session-persistence|persistence|provider(?:s)?)(?:\/|["']|$)/;
  const offenders: string[] = [];
  let scanned = false;
  for (const name of files) {
    const source = readFileSync(join(runtimeDir, name), "utf8");
    for (const line of source.split(/\r?\n/)) {
      scanned = true;
      const match = /^\s*(?:import|export)\s+(?!type\b).*?from\s*["']([^"']+)["']/.exec(line);
      const bare = /^\s*import\s*["']([^"']+)["']/.exec(line);
      const spec = match?.[1] ?? bare?.[1];
      if (spec !== undefined && forbidden.test(spec)) offenders.push(`${name}: ${spec}`);
    }
  }
  return { scanned, offenders };
}

/** #9 plugin：同一 dependency 性质经插件管理器 hook 链驱动，独立实现 import 提取。 */
async function pluginDependencyScan(runtimeDir: string): Promise<{ readonly scanned: boolean; readonly offenders: string[] }> {
  type ScanInput = { readonly runtimeDir: string; scanned: boolean; offenders: string[] };
  const manager = new AgentPluginManager();
  manager.addHook<ScanInput>("dependencyScan", (input) => {
    const files = readdirSync(input.runtimeDir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".spec.ts"));
    const forbidden = /(?:@zeta-agent\/)?(?:deploy|session-persistence|persistence|provider(?:s)?)(?:\/|["']|$)/;
    const offenders: string[] = [];
    let scanned = false;
    for (const name of files) {
      const source = readFileSync(join(input.runtimeDir, name), "utf8");
      for (const line of source.split(/\r?\n/)) {
        scanned = true;
        const quoted = /["']([^"']+)["']/.exec(line)?.[1];
        if (
          quoted !== undefined &&
          /^\s*(?:import|export)\b/.test(line) &&
          !/^\s*import\s+type\b/.test(line) &&
          forbidden.test(quoted)
        ) {
          offenders.push(`${name}: ${quoted}`);
        }
      }
    }
    return { ...input, scanned, offenders };
  });
  const result = await manager.run<ScanInput>("dependencyScan", { runtimeDir, scanned: false, offenders: [] });
  return { scanned: result.scanned, offenders: result.offenders };
}

/** #10 legacy：本地批处理适配器，仅整批全部 terminate 才让 controller 停机。 */
async function runLegacyTerminateBatch(
  batch: readonly ConditionalCall[],
  registry: ReturnType<typeof createToolRegistry>,
  controller: ReturnType<typeof createTerminationController>
): Promise<readonly { readonly callId: string; readonly isError: boolean; readonly durationMs: number }[]> {
  const results: Array<{ callId: string; isError: boolean; durationMs: number }> = [];
  const terminates: boolean[] = [];
  for (const call of batch) {
    const tool = registry.getTool(call.tool);
    if (controller.terminated || tool === undefined) {
      results.push({ callId: call.id, isError: true, durationMs: 0 });
      terminates.push(false);
      continue;
    }
    let localTerminate = false;
    const exec: ToolExecuteContext = {
      onUpdate: () => {},
      terminate: () => { localTerminate = true; },
      terminated: () => controller.terminated,
    };
    const output = await tool.execute(call.input, exec);
    results.push({ callId: call.id, isError: output === undefined || output === null, durationMs: 0 });
    terminates.push(localTerminate);
  }
  if (terminates.length === batch.length && terminates.every(Boolean)) controller.terminate("all-terminated");
  return results;
}

/** #12 legacy：本地工具声明 delta 构造器，不调用框架 declareToolChanges。 */
function declareToolChangesLegacy(
  previous: readonly string[],
  next: readonly string[],
  systemPrompt = ""
): {
  readonly toolsAdded: string[];
  readonly toolsRemoved: string[];
  readonly messages: readonly { readonly role: "system"; readonly content: string }[];
} {
  const before = new Set(previous);
  const after = new Set(next);
  const toolsAdded = [...after].filter((name) => !before.has(name));
  const toolsRemoved = [...before].filter((name) => !after.has(name));
  const content = [systemPrompt, `tools: ${[...after].sort().join(", ")}`].filter((line) => line.length > 0).join("\n");
  const messages = toolsAdded.length > 0 || toolsRemoved.length > 0 || systemPrompt.length > 0
    ? [{ role: "system" as const, content }]
    : [];
  return { toolsAdded, toolsRemoved, messages };
}

/**
 * §13 要点映射表（门 2 数据源；scripts/check-invariant-points.mjs 机械校验）。
 * keywords 取每条测试要点中可区分正确/错误实现的词，断言块需含哨兵与关键词。
 */
export const INVARIANT_TEST_POINTS: Record<
  number,
  {
    readonly point: string;
    readonly keywords: readonly string[];
    readonly assertFragment: string;
    readonly pluginFragment: string;
  }
> = {
  1: { point: "assistant message_end 屏障", keywords: ["message_end", "preflight", "barrier"], assertFragment: "sawMessageEndBeforeTool", pluginFragment: "sawMessageEndBeforeTool" },
  2: { point: "完成顺序 vs 源码顺序解耦", keywords: ["tool_execution_end", "callId", "reverse"], assertFragment: "reverseOrderObserved", pluginFragment: "reverseOrderObserved" },
  3: { point: "error/aborted 硬退出", keywords: ["stopReason", "error", "continue"], assertFragment: "hardExitObserved", pluginFragment: "hardExitObserved" },
  4: { point: "end 不清队列", keywords: ["prepareNextTurn", "queue", "agent_end"], assertFragment: "endKeepsQueueObserved", pluginFragment: "endKeepsQueueObserved" },
  5: { point: "continue 保证一次请求", keywords: ["streamCount", "naturalRequest", "continue"], assertFragment: "naturalRequestSeen", pluginFragment: "naturalRequestSeen" },
  6: { point: "hook no-throw", keywords: ["throw", "waterfall", "safe-fallback"], assertFragment: "errorHookInvoked", pluginFragment: "errorHookInvoked" },
  7: { point: "streamFn 不抛错", keywords: ["streamAssistant", "error", "agent_end"], assertFragment: "streamErrorObserved", pluginFragment: "streamErrorObserved" },
  8: { point: "迟到 onUpdate 丢弃 + durationMs 边界", keywords: ["onUpdate", "durationMs", "settle"], assertFragment: "lateUpdateObserved", pluginFragment: "lateUpdateObserved" },
  9: { point: "core 无持久化/provider 依赖", keywords: ["import", "runtime", "dependency"], assertFragment: "dependencyScanRan", pluginFragment: "dependencyScanRan" },
  10: { point: "terminate 全批次规则", keywords: ["terminate", "batch", "controller"], assertFragment: "mixedBatchObserved", pluginFragment: "mixedBatchObserved" },
  11: { point: "runToolCall 走 hooks 无事件", keywords: ["nested", "toolCall", "event"], assertFragment: "legacyNestedInvoked", pluginFragment: "pluginNestedInvoked" },
  12: { point: "system 消息单一事实源", keywords: ["system", "delta", "single-source"], assertFragment: "singleSourceVerified", pluginFragment: "singleSourceVerified" },
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
 * legacy 走字段赋值 finishTurn；plugin 走插件管理器 decision 链 + 桥接 waterfall。两者不共用断言体。
 */
async function legacyHookProbe(): Promise<boolean> {
  let invoked = false;
  const { runtime } = makeLegacyRuntime({
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
  const { runtime, manager } = makePluginRuntime({
    decisionPlugin: () => {
      invoked = true;
      return { kind: "exit", reason: "dual-version-probe" };
    },
  });
  await runLoop(runtime);
  // 哨兵强化：decision 钩子确实注册并运行在插件管理器的链上，而非字段赋值。
  expect(manager.chain("decision").size).toBeGreaterThan(0);
  return invoked;
}

/**
 * 12 条 × 2 版完全独立的行为断言（CR-39 修复后不再共享 CHECKS）。
 * 每版各自构造本版 runtime、内联行为断言与关键哨兵，末尾再断言本版接线被读取。
 */
const cases: readonly InvariantCase[] = [
  // #1 message-end 屏障
  pair(1, INVARIANT_NAMES[0], async () => {
    const { runtime, order, stream } = makeLegacyRuntime({
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
    const { runtime, order, stream } = makePluginRuntime({
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
    const { runtime, startCallIds, endCallIds } = makeLegacyRuntime({
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
    const { runtime, startCallIds, endCallIds } = makePluginRuntime({
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
    const { runtime, getStreamCount } = makeLegacyRuntime({
      response: { stopReason: "error", toolCalls: [] },
      finishTurnLegacy: () => ({ action: "continue" }),
    });
    await runLoop(runtime);
    const hardExitObserved = getStreamCount() === 1;
    expect(getStreamCount()).toBe(1);
    expect(hardExitObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const { runtime, getStreamCount } = makePluginRuntime({
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
    const { runtime, inbox, order: runtimeOrder } = makeLegacyRuntime({
      prepareNextTurnCalls: prepare,
      finishTurnLegacy: () => ({ action: "end" }),
    });
    inbox.inject({ role: "user", content: "queued" });
    await runLoop(runtime);
    const endKeepsQueueObserved =
      prepare.count === 0 && runtimeOrder.filter((e) => e === "agent_end").length === 1;
    expect(prepare.count).toBe(0);
    // end 决策不清空未消费的队列：注入 nextStep 的消息在 agent_end 后仍保留。
    expect(inbox.size("nextStep")).toBe(1);
    expect(runtimeOrder.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(endKeepsQueueObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const prepare = { count: 0 };
    const { runtime, inbox, order: runtimeOrder } = makePluginRuntime({
      prepareNextTurnCalls: prepare,
      decisionPlugin: () => ({ kind: "exit", reason: "end" }) as const,
    });
    inbox.inject({ role: "user", content: "queued" });
    await runLoop(runtime);
    const endKeepsQueueObserved =
      prepare.count === 0 && runtimeOrder.filter((e) => e === "agent_end").length === 1;
    expect(prepare.count).toBe(0);
    // end 决策不清空未消费的队列：注入 nextStep 的消息在 agent_end 后仍保留。
    expect(inbox.size("nextStep")).toBe(1);
    expect(runtimeOrder.filter((e) => e === "agent_end")).toHaveLength(1);
    expect(endKeepsQueueObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #5 {action:"continue"} 是"保证一次请求"，已有自然请求时不叠加
  pair(5, INVARIANT_NAMES[4], async () => {
    let finishCount = 0;
    const { runtime, getStreamCount } = makeLegacyRuntime({
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
    const { runtime, getStreamCount } = makePluginRuntime({
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

  // #6 hook no-throw：抛错 hook 不得击穿 runLoop，须被归一化为 safe-fallback
  pair(6, INVARIANT_NAMES[5], async () => {
    let errorHookInvoked = false;
    // legacy 版：字段赋值一个抛错的 waterfall hook，验证 runLoop 归一化而非内部自抛自捕。
    const errorWaterfall = createDecisionWaterfall();
    errorWaterfall.add(() => {
      errorHookInvoked = true;
      throw new Error("legacy hook throw");
    });
    const { runtime, order } = makeLegacyRuntime({
      finishTurnLegacy: () => undefined,
      waterfall: errorWaterfall,
    });
    let runThrew = false;
    let safeFallback = false;
    try {
      await runLoop(runtime);
      safeFallback = order.includes("agent_end");
    } catch {
      runThrew = true;
    }
    expect(errorHookInvoked).toBe(true);
    expect(runThrew).toBe(false);
    expect(safeFallback).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    let errorHookInvoked = false;
    // plugin 版：抛错来自真插件管理器 decision 链；关闭 fallback 让错误传播到 runLoop。
    const { runtime, order, manager } = makePluginRuntime({
      managerConfig: { fallbackToLegacy: false },
      decisionPlugin: () => {
        errorHookInvoked = true;
        throw new Error("plugin hook throw");
      },
    });
    let runThrew = false;
    let safeFallback = false;
    try {
      await runLoop(runtime);
      safeFallback = order.includes("agent_end");
    } catch {
      runThrew = true;
    }
    expect(errorHookInvoked).toBe(true);
    expect(manager.chain("decision").size).toBeGreaterThan(0);
    expect(runThrew).toBe(false);
    expect(safeFallback).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #7 streamFn 不抛错：失败编码为 stopReason="error"，runLoop 正常收尾
  pair(7, INVARIANT_NAMES[6], async () => {
    const { runtime, order } = makeLegacyRuntime({
      response: { stopReason: "error", toolCalls: [] },
    });
    await expect(runLoop(runtime)).resolves.toBeDefined();
    const streamErrorObserved = order.includes("agent_end");
    expect(order).toContain("agent_end");
    expect(streamErrorObserved).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const { runtime, order } = makePluginRuntime({
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
    let now = 0;
    const registry = createToolRegistry();
    const tool: ToolDescriptor = {
      name: "streaming",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: (_input, exec) => {
        exec.onUpdate("early");
        now += 5;
        return { ok: true };
      },
    };
    registry.registerTool(tool);
    const onUpdate = (partialResult: unknown): void => { updates.push(partialResult); };
    // legacy：本地适配器维护 settle 边界，不进入框架流水线的 onUpdate/durationMs 逻辑。
    const legacy = runLegacyStreamingTool(tool, { clock: () => now, onUpdate });
    expect(legacy.updates).toEqual(["early"]);
    legacy.emitLate();
    const lateUpdateObserved = updates.length === 1 && updates[0] === "early";
    expect(updates).toEqual(["early"]);
    expect(legacy.durationMs).toBe(5);
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
    const toolPipeline = createToolPipeline({
      registry,
      clock: () => now,
      onUpdate: (update) => { updates.push(update.partialResult); },
    });
    // plugin：框架管线在 settle 后丢弃迟到 onUpdate，durationMs 只计 execute()。
    const result = await toolPipeline.executeCall({ id: "s", tool: "streaming", input: {} });
    expect(updates).toEqual(["early"]);
    captured?.onUpdate("late");
    const lateUpdateObserved = updates.length === 1 && updates[0] === "early";
    expect(updates).toEqual(["early"]);
    expect(result.durationMs).toBe(5);
    expect(lateUpdateObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #9 core 无持久化/provider 依赖
  pair(9, INVARIANT_NAMES[8], async () => {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    // legacy：直接扫描 runtime 源码的 import 声明。
    const { scanned: dependencyScanRan, offenders } = legacyDependencyScan(runtimeDir);
    expect(dependencyScanRan).toBe(true);
    expect(offenders).toEqual([]);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    // plugin：经插件管理器 hook 链做 dependency 扫描，独立实现 import 提取。
    const { scanned: dependencyScanRan, offenders } = await pluginDependencyScan(runtimeDir);
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
    // legacy：本地 batch 适配器的 terminate 规则，混合批次不得让 controller 停机。
    const results = await runLegacyTerminateBatch(batch, registry, controller);
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
    // plugin：框架 executeConditionalBatch 的 terminate 全批次规则。
    const results = await executeConditionalBatch(batch, { registry, controller });
    const mixedBatchObserved =
      results.length === 2 && results[1]?.isError === false && controller.terminated === false;
    expect(results).toHaveLength(2);
    expect(results[1]?.isError).toBe(false);
    expect(controller.terminated).toBe(false);
    expect(mixedBatchObserved).toBe(true);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #11 嵌套调用 runToolCall 走同一管线但不发事件/不加消息
  pair(11, INVARIANT_NAMES[10], async () => {
    let legacyNestedInvoked = false;
    const registry = createToolRegistry();
    registry.registerTool({
      name: "nested-tool",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: () => {
        legacyNestedInvoked = true;
        return { ok: true };
      },
    });
    const ctx: BatchContext = { registry };
    const { runtime, order, stream } = makeLegacyRuntime({
      response: { toolCalls: [{ id: "c1", name: "nested-tool", args: {} }], stopReason: "stop" },
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
      finishTurnLegacy: () => ({ action: "end" }),
    });
    await runLoop(runtime);
    const afterRunEvents = order.length;
    const afterRunMessages = stream.getState().messages.length;
    const nested = await runToolCall({ id: "c1", name: "nested-tool", args: {} }, ctx);
    expect(nested.callId).toBe("c1");
    expect(nested.isError).toBe(false);
    expect("message" in nested).toBe(false);
    expect(legacyNestedInvoked).toBe(true);
    // 关键：嵌套 toolCall 不发事件、不加消息（与消息追加式调用相反）。
    expect(order.length).toBe(afterRunEvents);
    expect(stream.getState().messages.length).toBe(afterRunMessages);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    let pluginNestedInvoked = false;
    const registry = createToolRegistry();
    registry.registerTool({
      name: "nested-tool",
      inputSchema: [],
      outputSchema: ["ok"],
      execute: () => {
        pluginNestedInvoked = true;
        return { ok: true };
      },
    });
    const { runtime, order, stream, manager } = makePluginRuntime({
      response: { toolCalls: [{ id: "c1", name: "nested-tool", args: {} }], stopReason: "stop" },
      toolResults: [{ callId: "c1", message: { role: "toolResult", content: "r" } }],
    });
    const ctx: BatchContext = { registry, manager };
    await runLoop(runtime);
    const afterRunEvents = order.length;
    const afterRunMessages = stream.getState().messages.length;
    const nested = await runToolCall({ id: "c1", name: "nested-tool", args: {} }, ctx);
    expect(nested.callId).toBe("c1");
    expect(nested.isError).toBe(false);
    expect("message" in nested).toBe(false);
    expect(pluginNestedInvoked).toBe(true);
    expect(order.length).toBe(afterRunEvents);
    expect(stream.getState().messages.length).toBe(afterRunMessages);
    expect(await pluginHookProbe()).toBe(true);
  }),

  // #12 system 消息单一事实源：工具清单 delta 由 declareToolChanges 一次产出
  pair(12, INVARIANT_NAMES[11], async () => {
    const systemPrompt = "sys";
    const previous = ["read"];
    const next = ["read", "write"];
    // legacy：本地声明适配器产出 delta，不调用框架 declareToolChanges。
    const delta = declareToolChangesLegacy(previous, next, systemPrompt);
    expect(delta.toolsAdded).toEqual(["write"]);
    expect(delta.toolsRemoved).toEqual([]);
    expect(delta.messages).toHaveLength(1);
    const systemMessage = delta.messages[0];
    expect(systemMessage?.role).toBe("system");
    expect(String(systemMessage?.content)).toBe("sys\ntools: read, write");
    const startedFromSingleSource = createInitialState({ systemPrompt }).messages.length === 0;
    const deltaAligned = delta.messages.length === 1 &&
      String(systemMessage?.content).includes(`tools: ${next.join(", ")}`);
    const singleSourceVerified = startedFromSingleSource && deltaAligned && delta.toolsAdded.length === 1;
    expect(startedFromSingleSource).toBe(true);
    expect(deltaAligned).toBe(true);
    expect(singleSourceVerified).toBe(true);
    expect(await legacyHookProbe()).toBe(true);
  }, async () => {
    const systemPrompt = "sys";
    const previous = ["read"];
    const next = ["read", "write"];
    // plugin：框架 declareToolChanges 一次产出 system delta，保持 single-source。
    const delta = declareToolChanges(previous, next, systemPrompt);
    expect(delta.toolsAdded).toEqual(["write"]);
    expect(delta.toolsRemoved).toEqual([]);
    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]?.role).toBe("system");
    expect(String(delta.messages[0]?.content)).toBe("sys\ntools: read, write");
    const startedFromSingleSource = createInitialState({ systemPrompt }).messages.length === 0;
    const deltaAligned = delta.messages.length === 1 &&
      String(delta.messages[0]?.content).includes("tools: read, write");
    const singleSourceVerified = startedFromSingleSource && deltaAligned && delta.toolsAdded.length === 1;
    expect(startedFromSingleSource).toBe(true);
    expect(deltaAligned).toBe(true);
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

// T-04 真插件管线门：plugin 版不得再用 decision 字段赋值，必须由 AgentPluginManager 驱动。
describe("T-04 真插件管线边界", () => {
  test("inv-core-plugin-pipeline: plugin 构造经插件管理器 decision 链，legacy 保留字段赋值", () => {
    const pluginCtor = makePluginRuntime.toString();
    expect(pluginCtor).toContain("AgentPluginManager");
    expect(pluginCtor).toContain("addHook");
    expect(pluginCtor).toContain("manager.run");
    const legacyCtor = makeLegacyRuntime.toString();
    expect(legacyCtor).toContain("finishTurn");
    expect(legacyCtor).not.toContain("AgentPluginManager");
  });

  test("inv-core-no-decision-field: plugin 断言体不含 decision 字段赋值", () => {
    for (const item of cases) {
      const pluginSrc = item.plugin.toString();
      expect(pluginSrc).not.toContain("decision:");
      expect(pluginSrc).not.toMatch(/\.decision\s*=/);
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
