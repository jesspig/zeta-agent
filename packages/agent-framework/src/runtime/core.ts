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
} from "./agent";
import { createInbox, type Inbox } from "./inbox";
import {
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopDecision,
  type LoopRuntime,
  type ToolCall,
  type ToolResult,
} from "./loop";

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
}

export interface CorePluginApi extends AgentPluginApi {
  disposeAll(): void;
}

const END_DECISION: LoopDecision = Object.freeze({ action: "end" });

type CoreTool = { readonly name: string; readonly execute: (input: never, signal?: AbortSignal) => unknown };

function runTool(tool: CoreTool, args: unknown, signal?: AbortSignal): unknown {
  return (tool.execute as (input: unknown, signal?: AbortSignal) => unknown)(args, signal);
}

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
  private readonly inbox: Inbox = createInbox();

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
    if (userText === undefined && this.stream.getState().messages.length === 0) return this.stream.getState().messages;
    await this.stream.emit({ type: "agent_start" }, signal);

    const inbox = this.inbox;
    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    await this.manager.run("steering", inbox, signal);
    await this.manager.run("followUp", inbox, signal);

    const runtime: LoopRuntime = {
      inbox,
      signal,
      emit: (event) => this.stream.emit(event, signal),
      getState: () => this.stream.getState(),
      prepareNextTurn: async () => {
        await this.manager.run("prepareNextTurn", this.stream.getState(), signal);
        await this.loopHooks.prepareNextTurn?.(this.stream.getState(), signal);
      },
      prepareRequest: async (request) => {
        const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
        const prompt = this.resolveSystemPrompt();
        const seeded = {
          ...(request as object),
          messages: prompt.length > 0 && base.messages?.[0]?.role !== "system"
            ? [{ role: "system" as const, content: prompt }, ...(base.messages ?? [])]
            : (base.messages ?? []),
        };
        const prepared = await this.manager.run("prepareRequest", seeded, signal);
        return await this.loopHooks.prepareRequest?.(prepared, signal) ?? prepared;
      },
      finishTurn: async (turn: LastTurn): Promise<LoopDecision | undefined> => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        await this.manager.run("turnBoundary", event, signal);
        const legacy = await this.loopHooks.finishTurn?.(turn, signal);
        if (legacy !== undefined) return legacy;
        return this.lastTurnHadNativeTools && turn.toolResults.length > 0 ? undefined : END_DECISION;
      },
      pollFollowUp: async () => {
        const followUps = inbox.poll("followUp").map((item) => item.body);
        return await this.loopHooks.pollFollowUp?.(signal) ?? followUps;
      },
      streamAssistant: async (request): Promise<AssistantResult> => this.streamAssistant(request, signal),
      executeToolCalls: async (calls) => this.executeToolCalls(calls, signal),
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
    let terminal: { usage?: unknown; durationMs?: number; responseId?: string } = {};
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
                ...(record.usage !== undefined ? { usage: record.usage } : {}),
                ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
                ...(typeof record.responseId === "string" ? { responseId: record.responseId } : {}),
              };
              break;
            } else if (record.type === "error") {
              stopReason = "error";
              failure = record.error;
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
      message: { role: "assistant", content },
      toolCalls: stopReason === "error" || stopReason === "aborted" ? [] : calls,
      stopReason,
      ...terminal,
      ...(failure !== undefined ? { error: failure } : {}),
    };
  }

  private async executeToolCalls(calls: readonly ToolCall[], signal: AbortSignal): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];
    for (const [index, call] of calls.entries()) {
      const execute = this.tools.get(call.name);
      let output: unknown = "TOOL_NOT_FOUND";
      let isError = execute === undefined;
      if (execute !== undefined && !signal.aborted) {
        try {
          await this.manager.run("beforeToolCall", {
            type: "tool_execution_start",
            toolCallId: call.id,
            toolName: call.name,
            args: call.args,
          }, signal);
          if (signal.aborted) throw new Error("ABORTED");
          output = await runTool(execute, call.args, signal);
          await this.manager.run("afterToolCall", {
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result: output,
            isError: false,
          }, signal);
        } catch (error) {
          isError = true;
          output = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      } else if (signal.aborted) {
        isError = true;
        output = "ABORTED";
      }
      const id = call.id || `call-${index + 1}`;
      results.push({
        callId: id,
        message: { role: "toolResult", content: output, toolCallId: id, toolName: call.name },
        isError,
      });
    }
    return results;
  }
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
