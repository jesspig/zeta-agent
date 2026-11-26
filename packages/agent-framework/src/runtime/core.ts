import type { Disposer } from "@zeta-agent/framework";
import type {
  AgentPluginApi,
  AgentTool,
  Capabilities,
  CoreContextLike,
  EffectMeta,
  EventBus,
  RedactRule,
  StreamFn,
} from "../types";
import { AgentPluginManager, type PluginPipelineConfig } from "../plugins/manager";
import type { AgentPlugin } from "../plugins/types";
import {
  createEventStream,
  type AgentEvent,
  type AgentListener,
  type AgentMessage,
  type AgentState,
  type EventStream,
  type UsageSnapshot,
} from "./agent";
import { createInbox, type Inbox, type InboxMessage, type QueueMode, type QueueTarget } from "./inbox";
import {
  asNextTurnUpdate,
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopDecision,
  type LoopRuntime,
  type NextTurnUpdate,
  type SourcePollPhase,
  type ToolCall,
} from "./loop";
import { createToolPipeline, createToolRegistry } from "../tools/pipeline";

const ACTIVE_CAPABILITIES: Capabilities = Object.freeze({
  isolation: "active",
  seccomp: "active",
  fsConfinement: "active",
  auditSink: "active",
  egressDefaultDeny: "active",
});

function createSharedEventBus(): EventBus {
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  return {
    on(name, listener) {
      let bucket = listeners.get(name);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(name, bucket);
      }
      bucket.add(listener);
      return () => { bucket?.delete(listener); };
    },
    emit(name, event) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(event);
    },
  };
}

export interface CoreLoopHooks {
  readonly prepareNextTurn?: (context: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
  readonly prepareRequest?: (request: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
  readonly finishTurn?: LoopRuntime["finishTurn"];
  readonly pollFollowUp?: LoopRuntime["pollFollowUp"];
}

/** 通用核心工厂参数：工具与 provider 一律注入，核心不内置任何实现。 */
export interface CoreAgentOptions {
  readonly streamFn?: StreamFn;
  readonly plugins?: readonly AgentPlugin[];
  readonly tools?: readonly AgentTool[];
  readonly systemPrompt?: string | (() => string);
  readonly coreContext?: CoreContextLike;
  readonly eventBus?: EventBus;
  readonly capabilities?: () => Capabilities;
  readonly onEffect?: (handler: (meta: EffectMeta) => void) => Disposer;
  readonly emitEffect?: (meta: EffectMeta) => void;
  readonly addRedactor?: (rule: RedactRule) => Disposer;
  readonly pipeline?: Partial<PluginPipelineConfig>;
  readonly pluginManager?: AgentPluginManager;
  readonly loopHooks?: CoreLoopHooks;
  /** 单次 run 的 provider 回合上限。 */
  readonly turnBudget?: number;
}

export interface CorePluginApi extends AgentPluginApi {
  disposeAll(): void;
}

const CONTINUE_DECISION: LoopDecision = Object.freeze({ action: "continue" });
const END_DECISION: LoopDecision = Object.freeze({ action: "end" });

type CoreTool = {
  readonly name: string;
  readonly execute: (input: never, signal?: AbortSignal) => unknown;
  readonly executionMode?: "sequential" | "parallel";
};

interface RunLease {
  readonly generation: number;
  readonly controller: AbortController;
  promise: Promise<readonly AgentMessage[]>;
}

/** 通用 Agent 核心：插件管线 + loop + 事件流 + 生命周期。 */
export class Agent {
  private readonly stream: EventStream = createEventStream();
  private readonly manager: AgentPluginManager;
  private readonly baseStreamFn: StreamFn | undefined;
  private readonly tools = new Map<string, CoreTool>();
  private readonly coreContextValue: CoreContextLike | undefined;
  private readonly bus: EventBus;
  private readonly capabilitiesFn: () => Capabilities;
  private readonly onEffectFn: (handler: (meta: EffectMeta) => void) => Disposer;
  private readonly emitEffectFn: ((meta: EffectMeta) => void) | undefined;
  private readonly addRedactorFn: (rule: RedactRule) => Disposer;
  private readonly systemPrompt: string | (() => string) | undefined;
  private readonly loopHooks: CoreLoopHooks;
  private readonly turnBudget: number | undefined;
  private readonly inbox: Inbox = createInbox();
  private activeSignal: AbortSignal | undefined;

  private abortedValue = false;
  private generation = 0;
  private activeRun: RunLease | undefined;
  private lastTurnHadNativeTools = false;

  readonly api: CorePluginApi;
  readonly plugins: AgentPluginManager;

  constructor(options: CoreAgentOptions = {}) {
    this.manager = options.pluginManager ?? new AgentPluginManager({ config: options.pipeline });
    this.plugins = this.manager;
    this.baseStreamFn = options.streamFn;
    this.coreContextValue = options.coreContext;
    this.bus = options.eventBus ?? createSharedEventBus();
    this.capabilitiesFn = options.capabilities ?? (() => ACTIVE_CAPABILITIES);
    this.onEffectFn = options.onEffect ?? (() => () => {});
    this.emitEffectFn = options.emitEffect;
    this.addRedactorFn = options.addRedactor ?? (() => () => {});
    this.systemPrompt = options.systemPrompt;
    this.loopHooks = options.loopHooks ?? {};
    this.turnBudget = options.turnBudget;

    // legacy 字段 hook 经 setLegacy 进入同一链（最低优先级），生产路径不再旁路调用。
    const legacyHooks = this.loopHooks;
    if (legacyHooks.prepareRequest !== undefined) {
      this.manager.setLegacy("prepareRequest", (input) =>
        legacyHooks.prepareRequest!(input, this.activeSignal) ?? input);
    }
    if (legacyHooks.prepareNextTurn !== undefined) {
      this.manager.setLegacy("prepareNextTurn", (input) =>
        legacyHooks.prepareNextTurn!(input, this.activeSignal));
    }
    if (legacyHooks.finishTurn !== undefined) {
      this.manager.setLegacy("turnBoundary", (input) => {
        const event = input as AgentEvent;
        const turn: LastTurn = event.type === "turn_end"
          ? { message: event.message, toolResults: event.toolResults }
          : { message: { role: "assistant", content: "" }, toolResults: [] };
        return legacyHooks.finishTurn!(turn, this.activeSignal);
      });
    }
    if (legacyHooks.pollFollowUp !== undefined) {
      this.manager.setLegacy("pollFollowUp", async () =>
        (await legacyHooks.pollFollowUp!(this.activeSignal)) ?? undefined);
    }

    for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);

    this.api = {
      registerTool: (tool) => {
        const name = tool.name;
        if (typeof name !== "string" || name.length === 0) throw new Error("api.registerTool: name required");
        const stop = this.manager.addDisposer(() => { this.tools.delete(name); });
        this.tools.set(name, tool);
        return stop;
      },
      onEvent: (handler) => this.manager.addDisposer(this.stream.subscribe(handler)),
      addConverter: (fn) => this.manager.addHook<unknown>("converter", fn),
      addContextTransform: (fn) => this.manager.addHook<unknown>("contextTransform", fn),
      addBeforeToolCall: (fn) => this.manager.addHook<AgentEvent>("beforeToolCall", fn),
      addAfterToolCall: (fn) => this.manager.addHook<AgentEvent>("afterToolCall", fn),
      addTurnBoundary: (fn) => this.manager.addHook<AgentEvent>("turnBoundary", fn),
      addPrepareRequest: (fn) => this.manager.addHook<unknown>("prepareRequest", fn),
      addPrepareNextTurn: (fn) => this.manager.addHook<unknown>("prepareNextTurn", fn),
      provideSteering: (source) => this.manager.addHook<Inbox>("steering", async (inbox) => {
        inbox.steer(await source.next() as AgentMessage);
      }),
      provideFollowUp: (source) => this.manager.addHook<Inbox>("followUp", async (inbox) => {
        inbox.followUp(await source.next() as AgentMessage);
      }),
      provideStreamFn: (fn) => this.manager.addHook<unknown>("streamFn", fn),
      declareToolLoadout: (tools) => {
        this.tools.clear();
        for (const tool of tools) this.tools.set(tool.name, tool);
      },
      useContext: () => this.coreContextValue,
      events: this.bus,
      capabilities: () => this.capabilitiesFn(),
      onEffect: (handler) => this.onEffectFn(handler),
      addRedactor: (rule) => this.addRedactorFn(rule),
      disposeAll: () => this.manager.disposeAll(),
    };

    for (const plugin of options.plugins ?? []) {
      for (const contribution of plugin.contributions) {
        if (contribution.kind === "tool") this.tools.set(contribution.tool.name, contribution.tool);
        else if (contribution.kind === "hook") {
          const event = contribution.event;
          const handler = contribution.handler;
          this.manager.addDisposer(this.stream.subscribe(async (item) => {
            if (item.type === event) await handler(item);
          }));
        }
      }
    }
  }

  get aborted(): boolean {
    return this.abortedValue;
  }

  get state(): AgentState {
    return this.stream.getState();
  }

  get toolNames(): readonly string[] {
    return [...this.tools.keys()];
  }

  subscribe(listener: AgentListener): Disposer {
    return this.stream.subscribe(listener);
  }

  abort(): void {
    this.abortedValue = true;
    this.activeRun?.controller.abort();
  }

  reset(): void {
    if (this.activeRun !== undefined) throw new Error("ACTIVE_RUN: reset 必须等待当前 run 结束");
    this.generation += 1;
    this.abortedValue = false;
    this.lastTurnHadNativeTools = false;
    this.inbox.clear("nextTurn");
    this.inbox.clear("nextStep");
    this.inbox.clear("followUp");
    this.stream.reset();
  }

  steer(message: AgentMessage): void {
    this.inbox.steer(message);
  }

  followUp(message: AgentMessage): void {
    this.inbox.followUp(message);
  }

  inject(message: AgentMessage): InboxMessage {
    return this.inbox.inject(message);
  }

  setQueueMode(mode: QueueMode): void {
    this.inbox.setMode(mode);
  }

  getQueueMode(): QueueMode {
    return this.inbox.getMode();
  }

  queueSize(target: QueueTarget): number {
    return this.inbox.size(target);
  }

  private async pollQueueSources(signal: AbortSignal, kinds: "all" | "steering" = "all"): Promise<void> {
    await this.manager.run("steering", this.inbox, signal);
    // prepareNextTurn 只重轮询 steering：followUp 在这里重入会与 natural end 外层消费互相喂料而无限续跑。
    if (kinds === "all") await this.manager.run("followUp", this.inbox, signal);
  }

  async waitForIdle(): Promise<void> {
    while (this.activeRun !== undefined) {
      await this.activeRun.promise.catch(() => {});
    }
    await this.stream.waitForIdle();
  }

  emitEffect(meta: EffectMeta): void {
    this.emitEffectFn?.(meta);
  }

  prompt(text: string, signal?: AbortSignal): Promise<readonly AgentMessage[]> {
    if (typeof text !== "string") return Promise.reject(new Error("prompt: expected a string"));
    try {
      return this.startRun(text, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  continue(signal?: AbortSignal): Promise<readonly AgentMessage[]> {
    try {
      return this.startRun(undefined, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private startRun(userText: string | undefined, externalSignal?: AbortSignal): Promise<readonly AgentMessage[]> {
    if (this.activeRun !== undefined) throw new Error("ACTIVE_RUN: 同一 Agent 同时只能运行一个 prompt/continue");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted === true) onAbort();
    else externalSignal?.addEventListener("abort", onAbort, { once: true });
    const lease: RunLease = { generation: ++this.generation, controller, promise: Promise.resolve([]) };
    this.activeRun = lease;
    this.abortedValue = false;
    this.lastTurnHadNativeTools = false;
    const execution = this.executeRun(lease, userText).finally(() => {
      externalSignal?.removeEventListener("abort", onAbort);
      if (this.activeRun === lease) this.activeRun = undefined;
    });
    lease.promise = execution;
    return execution;
  }

  private resolveSystemPrompt(): string {
    if (typeof this.systemPrompt === "function") return this.systemPrompt();
    if (typeof this.systemPrompt === "string") return this.systemPrompt;
    return "";
  }

  private activeStreamFn(): StreamFn | undefined {
    const providers = this.manager.chain<StreamFn>("streamFn").snapshot();
    const provider = providers.at(-1)?.fn as StreamFn | undefined;
    return provider ?? this.baseStreamFn;
  }

  private async emitConverted(input: unknown, signal: AbortSignal): Promise<void> {
    const converters = this.manager.chain("converter").snapshot();
    for (const entry of converters) {
      const event = await entry.fn(input, signal) as AgentEvent | undefined;
      if (event !== undefined) await this.stream.emit(event, signal);
    }
  }

  private async executeRun(lease: RunLease, userText?: string): Promise<readonly AgentMessage[]> {
    const signal = lease.controller.signal;
    this.activeSignal = signal;
    if (userText === undefined && this.stream.getState().messages.length === 0) return this.stream.getState().messages;
    await this.stream.emit({ type: "agent_start" }, signal);

    const inbox = this.inbox;
    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    await this.pollQueueSources(signal);
    // followUp 交给 runLoop 外层：natural end 同轮消费，硬终局保留到下一个 run 的自然终局。

    const registry = createToolRegistry();
    for (const [name, tool] of this.tools) {
      registry.registerTool({
        name,
        // 核心工具不声明参数 schema：允许任意键，类型与业务校验由工具自身负责。
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        executionMode: tool.executionMode,
        execute: (input, exec) =>
          (tool.execute as (value: unknown, signal?: AbortSignal) => unknown)(input, exec.signal),
      });
    }

    const runtime: LoopRuntime = {
      inbox,
      signal,
      turnBudget: this.turnBudget,
      emit: (event) => this.stream.emit(event, signal),
      getState: () => this.stream.getState(),
      prepareNextTurn: async (): Promise<NextTurnUpdate | undefined> =>
        asNextTurnUpdate(await this.manager.run("prepareNextTurn", this.stream.getState(), signal)),
      pollSources: async (phase: SourcePollPhase): Promise<void> => {
        await this.pollQueueSources(signal, phase === "prepareNextTurn" ? "steering" : "all");
      },
      prepareRequest: async (request) => {
        const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
        const prompt = this.resolveSystemPrompt();
        const alreadyInjected = base.messages?.some((message) => message.role === "system" && message.content === prompt) === true;
        const seeded = {
          ...(request as object),
          messages: prompt.length > 0 && !alreadyInjected
            ? [{ role: "system" as const, content: prompt }, ...(base.messages ?? [])]
            : (base.messages ?? []),
        };
        return await this.manager.run("prepareRequest", seeded, signal);
      },
      finishTurn: async (turn: LastTurn): Promise<LoopDecision | undefined> => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        const outcome = await this.manager.run("turnBoundary", event, signal);
        if (isLoopDecision(outcome)) return outcome;
        // 原生工具结果必须被下一轮消费：显式 continue；否则 natural end 交给 runLoop 外层。
        if (this.lastTurnHadNativeTools && turn.toolResults.length > 0) return CONTINUE_DECISION;
        // 非原生 toolCalls（兼容文本标记等）保持单轮收束，避免默认续跑反复解析。
        if (turn.toolResults.length > 0) return END_DECISION;
        return undefined;
      },
      pollFollowUp: async () => {
        const followUps = inbox.poll("followUp").map((item) => item.body);
        return await this.manager.run("pollFollowUp", followUps, signal);
      },
      streamAssistant: async (request): Promise<AssistantResult> => this.streamAssistant(request, signal),
      toolPipeline: createToolPipeline({
        registry,
        manager: this.manager,
        signal: lease.controller.signal,
      }),
    };

    try {
      await runLoop(runtime);
    } catch (error) {
      if (!signal.aborted) {
        const message: AgentMessage = { role: "assistant", content: `Error: ${error instanceof Error ? error.message : String(error)}` };
        await this.stream.emit({ type: "message_start", message }, signal);
        await this.stream.emit({ type: "message_end", message }, signal);
        await this.stream.emit({ type: "turn_end", message, toolResults: [] }, signal);
        await this.stream.emit({ type: "agent_end", messages: [message] }, signal);
      }
    }
    return this.stream.getState().messages;
  }

  private async streamAssistant(request: unknown, signal: AbortSignal): Promise<AssistantResult> {
    const fn = this.activeStreamFn();
    let content = "";
    const calls: ToolCall[] = [];
    let stopReason: AssistantResult["stopReason"] = "stop";
    let terminal: { usage?: UsageSnapshot; durationMs?: number; responseId?: string } = {};
    let failure: unknown;
    this.lastTurnHadNativeTools = false;
    try {
      if (fn !== undefined) {
        const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
        for await (const chunk of fn({ ...base, messages: base.messages ?? [], signal })) {
          if (signal.aborted) { stopReason = "aborted"; break; }
          if (typeof chunk === "string") {
            await this.emitConverted(chunk, signal);
            content += chunk;
          } else if (typeof chunk === "object" && chunk !== null) {
            const record = chunk as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; id?: unknown; stopReason?: unknown; usage?: unknown; durationMs?: unknown; responseId?: unknown; error?: unknown };
            if (record.type === "text" && typeof record.text === "string") content += record.text;
            else if (record.type === "reasoning" && typeof record.text === "string") await this.emitConverted(record.text, signal);
            else if (record.type === "tool_call" && typeof record.name === "string") {
              calls.push({ id: typeof record.id === "string" ? record.id : `call-${calls.length + 1}`, name: record.name, args: parseArgs(record.arguments) });
            } else if (record.type === "done") {
              stopReason = isStopReason(record.stopReason) ? record.stopReason : "stop";
              terminal = {
                ...(typeof record.usage === "object" && record.usage !== null ? { usage: record.usage as UsageSnapshot } : {}),
                ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
                ...(typeof record.responseId === "string" ? { responseId: record.responseId } : {}),
              };
              break;
            } else if (record.type === "error") {
              stopReason = "error";
              failure = record.error;
              // 错误终态只保留可诊断元数据；usage 不进入消息，避免重试后重复计费。
              terminal = {
                ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
                ...(typeof record.responseId === "string" ? { responseId: record.responseId } : {}),
              };
              break;
            }
          }
        }
      }
    } catch (error) {
      stopReason = signal.aborted ? "aborted" : "error";
      failure = error;
    }
    if (signal.aborted) stopReason = "aborted";
    if (stopReason === "error") content = `Error: ${messageOf(failure)}`;
    this.lastTurnHadNativeTools = calls.length > 0;
    return {
      message: {
        role: "assistant",
        content,
        ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
        ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
        ...(terminal.responseId !== undefined ? { responseId: terminal.responseId } : {}),
      },
      toolCalls: stopReason === "error" || stopReason === "aborted" ? [] : calls,
      stopReason,
      ...terminal,
      ...(failure !== undefined ? { error: failure } : {}),
    };
  }

}

function isLoopDecision(value: unknown): value is LoopDecision {
  if (typeof value !== "object" || value === null) return false;
  const action = (value as { readonly action?: unknown }).action;
  return action === "continue" || action === "end";
}

function isStopReason(value: unknown): value is AssistantResult["stopReason"] {
  return value === "stop" || value === "length" || value === "error" || value === "aborted";
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** 通用核心工厂；应用层的工具、provider、安全与观测能力通过 options 注入。 */
export function createAgent(options: CoreAgentOptions = {}): Agent {
  return new Agent(options);
}
