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
      return () => {
        bucket?.delete(listener);
      };
    },
    emit(name, event) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(event);
    },
  };
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
}

export interface CorePluginApi extends AgentPluginApi {
  disposeAll(): void;
}

const END_DECISION: LoopDecision = Object.freeze({ action: "end" });

type CoreTool = { readonly name: string; readonly execute: (input: never) => unknown };

function runTool(tool: CoreTool, args: unknown): unknown {
  return (tool.execute as (input: unknown) => unknown)(args);
}

/**
 * 通用 Agent 核心：插件管线 + loop + 事件流 + 生命周期。
 * 不含内置工具、provider、持久化与安全/观测后端——这些由应用层装配后注入。
 */
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

  private abortedValue = false;
  private abortController: AbortController | undefined;
  private lastTurnHadNativeTools = false;

  readonly api: CorePluginApi;
  readonly plugins: AgentPluginManager;

  constructor(options: CoreAgentOptions = {}) {
    this.manager = new AgentPluginManager({ config: options.pipeline });
    this.plugins = this.manager;
    this.baseStreamFn = options.streamFn;
    this.coreContextValue = options.coreContext;
    this.bus = options.eventBus ?? createSharedEventBus();
    this.capabilitiesFn = options.capabilities ?? (() => ACTIVE_CAPABILITIES);
    this.onEffectFn = options.onEffect ?? (() => () => {});
    this.emitEffectFn = options.emitEffect;
    this.addRedactorFn = options.addRedactor ?? (() => () => {});
    this.systemPrompt = options.systemPrompt;

    for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);

    this.api = {
      registerTool: (tool) => {
        const name = tool.name;
        if (typeof name !== "string" || name.length === 0) throw new Error("api.registerTool: name required");
        const stop = this.manager.addDisposer(() => {
          this.tools.delete(name);
        });
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
      provideSteering: (source) => this.manager.addHook<Inbox>("steering", (inbox) => {
        inbox.steer(source.next() as AgentMessage);
      }),
      provideFollowUp: (source) => this.manager.addHook<Inbox>("followUp", (inbox) => {
        inbox.followUp(source.next() as AgentMessage);
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
          this.manager.addDisposer(this.stream.subscribe((item) => {
            if (item.type === event) handler(item);
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
    this.abortController?.abort();
  }

  reset(): void {
    this.abortedValue = false;
    this.abortController = undefined;
    this.lastTurnHadNativeTools = false;
    this.stream.reset();
  }

  waitForIdle(): Promise<void> {
    return this.stream.waitForIdle();
  }

  emitEffect(meta: EffectMeta): void {
    this.emitEffectFn?.(meta);
  }

  prompt(text: string): Promise<readonly AgentMessage[]> {
    if (typeof text !== "string") throw new Error("prompt: expected a string");
    return this.runTurn(text);
  }

  continue(): Promise<readonly AgentMessage[]> {
    return this.runTurn();
  }

  private resolveSystemPrompt(): string {
    if (typeof this.systemPrompt === "function") return this.systemPrompt();
    if (typeof this.systemPrompt === "string") return this.systemPrompt;
    return "";
  }

  private activeStreamFn(): StreamFn | undefined {
    const providers = this.manager.chain<StreamFn>("streamFn").snapshot();
    const last = providers[providers.length - 1];
    const provider = last?.fn as StreamFn | undefined;
    return provider ?? this.baseStreamFn;
  }

  private async emitConverted(input: unknown): Promise<void> {
    const converters = this.manager.chain("converter").snapshot();
    for (const entry of converters) {
      const event = await entry.fn(input) as AgentEvent | undefined;
      if (event !== undefined) await this.stream.emit(event);
    }
  }

  private async runTurn(userText?: string): Promise<readonly AgentMessage[]> {
    this.abortedValue = false;
    this.abortController = new AbortController();
    if (userText === undefined && this.stream.getState().messages.length === 0) {
      return this.stream.getState().messages;
    }
    await this.stream.emit({ type: "agent_start" });

    const inbox: Inbox = createInbox();
    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    await this.manager.run("steering", inbox);
    await this.manager.run("followUp", inbox);

    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => this.stream.emit(event),
      getState: () => this.stream.getState(),
      prepareNextTurn: () => {
        void this.manager.run("prepareNextTurn", this.stream.getState());
      },
      prepareRequest: (request) => {
        const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
        const prompt = this.resolveSystemPrompt();
        const seeded = {
          ...(request as object),
          messages:
            prompt.length > 0 && base.messages?.[0]?.role !== "system"
              ? [{ role: "system" as const, content: prompt }, ...(base.messages ?? [])]
              : (base.messages ?? []),
        };
        return this.manager.run("prepareRequest", seeded);
      },
      finishTurn: (turn: LastTurn): LoopDecision | undefined => {
        const event: AgentEvent = {
          type: "turn_end",
          message: turn.message,
          toolResults: turn.toolResults,
        };
        void this.manager.run("turnBoundary", event);
        return this.lastTurnHadNativeTools && turn.toolResults.length > 0 ? undefined : END_DECISION;
      },
      pollFollowUp: () => inbox.poll("nextTurn").map((item) => item.body),
      streamAssistant: async (request: unknown): Promise<AssistantResult> => {
        const fn = this.activeStreamFn();
        let content = "";
        const calls: ToolCall[] = [];
        this.lastTurnHadNativeTools = false;
        if (fn !== undefined) {
          const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
          for await (const chunk of fn({
            ...base,
            messages: base.messages ?? [],
            signal: this.abortController?.signal,
          })) {
            if (this.abortedValue) break;
            if (typeof chunk === "string") {
              await this.emitConverted(chunk);
              content += chunk;
            } else if (typeof chunk === "object" && chunk !== null) {
              const record = chunk as {
                type?: unknown;
                text?: unknown;
                name?: unknown;
                arguments?: unknown;
                id?: unknown;
              };
              if (record.type === "text" && typeof record.text === "string") content += record.text;
              else if (record.type === "tool_call" && typeof record.name === "string") {
                calls.push({
                  id: typeof record.id === "string" ? record.id : `call-${calls.length + 1}`,
                  name: record.name,
                  args: parseArgs(record.arguments),
                });
              }
            }
          }
        }
        this.lastTurnHadNativeTools = calls.length > 0;
        return {
          message: { role: "assistant", content },
          toolCalls: calls,
          stopReason: this.abortedValue ? "aborted" : "stop",
        };
      },
      executeToolCalls: async (calls: readonly ToolCall[]): Promise<readonly ToolResult[]> => {
        const results: ToolResult[] = [];
        for (const [index, call] of calls.entries()) {
          const execute = this.tools.get(call.name);
          let output: unknown = "TOOL_NOT_FOUND";
          let isError = execute === undefined;
          if (execute !== undefined && !this.abortedValue) {
            try {
              await this.manager.run("beforeToolCall", {
                type: "tool_execution_start",
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
              });
              output = await runTool(execute, call.args);
              await this.manager.run("afterToolCall", {
                type: "tool_execution_end",
                toolCallId: call.id,
                toolName: call.name,
                result: output,
                isError: false,
              });
            } catch (error) {
              isError = true;
              output = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          const id = call.id || `call-${index + 1}`;
          results.push({
            callId: id,
            message: { role: "toolResult", content: output, toolCallId: id, toolName: call.name },
            isError,
          });
        }
        return results;
      },
    };

    await runLoop(runtime);
    return this.stream.getState().messages;
  }
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
