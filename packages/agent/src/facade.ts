import {
  createEventStream,
  createInbox,
  runLoop,
  type AgentEvent,
  type AgentListener,
  type AgentMessage,
  type AgentPluginApi,
  type AgentState,
  type AssistantMessageEvent,
  type AssistantResult,
  type Capabilities,
  type ContextTransform,
  type Converter,
  type CoreContextLike,
  type EffectMeta,
  type EventBus,
  type FinishTurn,
  type Inbox,
  type LoopRuntime,
  type PrepareNextTurn,
  type PrepareRequest,
  type QueueSource,
  type RedactRule,
  type StreamFn,
  type ToolCall,
  type ToolResult,
} from "@zeta-agent/agent-framework";
import type { Disposer } from "@zeta-agent/framework";
import { builtinToolDefinitions, type ToolDefinition } from "./tools/builtins";
import {
  createEffectBridge,
  createLogger,
  resolveLogSink,
  type EffectBridge,
  type Logger,
  type LoggerOptions,
  type SinkOptions,
  type SinkResolution,
} from "@zeta-agent/observability";
import {
  createExecutionBackend,
  isCriticalLayerDegraded,
  type ExecutionBackend,
} from "@zeta-agent/security";

export type {
  AgentEvent,
  AgentListener,
  AgentMessage,
  AgentState,
} from "@zeta-agent/agent-framework";

export interface PluginTool<P = never> {
  readonly name: string;
  readonly execute: (input: P) => unknown;
}

export type PluginContribution =
  | { readonly kind: "tool"; readonly tool: PluginTool }
  | { readonly kind: "hook"; readonly event: string; readonly handler: (event: AgentEvent) => void }
  | { readonly kind: "section"; readonly text: string }
  | { readonly kind: "wrap"; readonly name: string }
  | { readonly kind: "task"; readonly name: string }
  | { readonly kind: "service"; readonly name: string };

export interface AgentPlugin {
  readonly kind: "AgentPlugin";
  readonly name: string;
  readonly contributions: readonly PluginContribution[];
  install(): Disposer;
}

export interface CompatExtensionApi {
  registerTool<P>(tool: PluginTool<P>): void;
  on(event: string, handler: (event: AgentEvent) => void): void;
  addSection(text: string): void;
}

export interface DurableExtensionSpec {
  readonly tools?: readonly PluginTool[];
  readonly hooks?: readonly { readonly event: string; readonly handler: (event: AgentEvent) => void }[];
  readonly sections?: readonly string[];
  readonly wraps?: readonly string[];
  readonly tasks?: readonly string[];
}

export const DEFAULT_ASSEMBLY: readonly string[] = Object.freeze([
  "builtin:read",
  "builtin:bash",
  "builtin:edit",
  "builtin:write",
  "skills:registry",
  "session:store",
]);

export function listAssembly(): readonly string[] {
  return [...DEFAULT_ASSEMBLY];
}

function defineAgentPlugin(name: string, contributions: readonly PluginContribution[]): AgentPlugin {
  if (typeof name !== "string" || name.length === 0) throw new Error("plugin: name required");
  const normalized = Object.freeze([...contributions]);
  let installed = false;
  return {
    kind: "AgentPlugin",
    name,
    contributions: normalized,
    install() {
      if (installed) throw new Error("PLUGIN_ALREADY_INSTALLED");
      installed = true;
      return () => {
        installed = false;
      };
    },
  };
}

export function defineCompatExtension(
  name: string,
  define: (api: CompatExtensionApi) => void
): AgentPlugin {
  if (typeof define !== "function") throw new Error("compat extension: expected a builder");
  const contributions: PluginContribution[] = [];
  const api: CompatExtensionApi = {
    registerTool(tool) {
      contributions.push({ kind: "tool", tool });
    },
    on(event, handler) {
      contributions.push({ kind: "hook", event, handler });
    },
    addSection(text) {
      contributions.push({ kind: "section", text });
    },
  };
  define(api);
  return defineAgentPlugin(name, contributions);
}

export function defineDurableExtension(name: string, spec: DurableExtensionSpec): AgentPlugin {
  if (spec === null || typeof spec !== "object") {
    throw new Error("durable extension: expected a spec");
  }
  const contributions: PluginContribution[] = [];
  for (const tool of spec.tools ?? []) contributions.push({ kind: "tool", tool });
  for (const hook of spec.hooks ?? []) {
    contributions.push({ kind: "hook", event: hook.event, handler: hook.handler });
  }
  for (const text of spec.sections ?? []) contributions.push({ kind: "section", text });
  for (const entry of spec.wraps ?? []) contributions.push({ kind: "wrap", name: entry });
  for (const entry of spec.tasks ?? []) contributions.push({ kind: "task", name: entry });
  return defineAgentPlugin(name, contributions);
}

function builtinTools(options: {
  readonly securityBackend: ExecutionBackend;
  readonly allowedDirectories: readonly string[];
}): ToolDefinition[] {
  return [...builtinToolDefinitions(options)];
}

export interface PluginApiSurface extends AgentPluginApi {
  /** 按 LIFO 撤销所有经 api 注册的贡献（含兼容门面贡献的 hook）。 */
  disposeAll(): void;
}

/** 插件间共享的轻量事件总线；按注册顺序同步派发。 */
function createEventBus(): EventBus {
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

export interface AgentToolCall {
  readonly name: string;
  readonly execute: () => unknown | Promise<unknown>;
}

export type ToolFailure = { readonly ok: false; readonly reason: string } | { readonly ok: true; readonly value: unknown };

export interface AgentStreamRequest {
  readonly messages: readonly AgentMessage[];
}

export type AgentStreamFn = (request: AgentStreamRequest) => AsyncIterable<string>;

const ACTIVE_CAPABILITIES: Capabilities = Object.freeze({
  isolation: "active",
  seccomp: "active",
  fsConfinement: "active",
  auditSink: "active",
  egressDefaultDeny: "active",
});

function defaultSecurityBackend(): ExecutionBackend {
  return createExecutionBackend({
    name: "facade-default",
    capabilities: { ...ACTIVE_CAPABILITIES },
    executor: () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
  });
}

function defaultLoggerOptions(): LoggerOptions {
  return { runId: "agent", sink: () => {} };
}

export interface AgentOptions {
  readonly streamFn?: AgentStreamFn;
  readonly plugins?: readonly AgentPlugin[];
  readonly includeBuiltins?: boolean;
  readonly securityBackend?: ExecutionBackend;
  readonly observability?: LoggerOptions;
  readonly effectBridge?: EffectBridge;
  readonly coreContext?: CoreContextLike;
  readonly allowedDirectories?: readonly string[];
}

export interface Agent extends PluginApiSurface {
  prompt(text: string): Promise<readonly AgentMessage[]>;
  continue(): Promise<readonly AgentMessage[]>;
  subscribe(listener: AgentListener): Disposer;
  abort(): void;
  waitForIdle(): Promise<void>;
  runTool(call: AgentToolCall): Promise<ToolFailure>;
  emitEffect(meta: EffectMeta): void;
  resolveLogSink(options: SinkOptions): SinkResolution;
  readonly api: PluginApiSurface;
  readonly logger: Logger;
  readonly aborted: boolean;
  readonly state: AgentState;
  readonly toolNames: readonly string[];
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly assembly: readonly string[];
}

export function createAgent(options: AgentOptions = {}): Agent {
  const stream = createEventStream();
  const baseStreamFn = options.streamFn;
  const includeBuiltins = options.includeBuiltins !== false;
  const plugins = options.plugins ?? [];
  const securityBackend = options.securityBackend ?? defaultSecurityBackend();
  const allowedDirectories = options.allowedDirectories ?? [];
  const toolDefinitions = includeBuiltins
    ? builtinTools({ securityBackend, allowedDirectories })
    : [];
  const contributions: PluginContribution[] = includeBuiltins
    ? toolDefinitions.map((tool) => ({ kind: "tool", tool }))
    : [];
  contributions.push({ kind: "service", name: "skills:registry" });
  contributions.push({ kind: "service", name: "session:store" });
  for (const plugin of plugins) contributions.push(...plugin.contributions);

  const assembly = includeBuiltins ? listAssembly() : [];

  const logger = createLogger(options.observability ?? defaultLoggerOptions());
  const effectBridge = options.effectBridge ?? createEffectBridge();
  const fiberLogger = logger.forFiber("agent");

  stream.subscribe((event) => {
    const content = "message" in event ? String(event.message.content) : event.type;
    fiberLogger.info(`${event.type} ${content}`);
  });

  let aborted = false;

  // 插件 API 的可变注册集合。每个 add* 返回幂等 disposer；disposeAll 按 LIFO 撤销。
  const pluginTools = new Map<string, { readonly tool: PluginTool; readonly dispose: () => void }>();
  const declaredLoadout = new Map<string, PluginTool>();
  const converters: Converter[] = [];
  const contextTransforms: ContextTransform[] = [];
  const beforeToolCalls: Array<(event: AgentEvent) => void | Promise<void>> = [];
  const afterToolCalls: Array<(event: AgentEvent) => void | Promise<void>> = [];
  const turnBoundaries: FinishTurn[] = [];
  const prepareRequestFns: PrepareRequest[] = [];
  const prepareNextTurnFns: PrepareNextTurn[] = [];
  const steeringSources: QueueSource[] = [];
  const followUpSources: QueueSource[] = [];
  const streamFnProviders: StreamFn[] = [];
  const disposers: Array<() => void> = [];
  const events = createEventBus();

  function addDisposer(dispose: () => void): () => void {
    let active = true;
    const wrapped = (): void => {
      if (!active) return;
      active = false;
      dispose();
      const index = disposers.indexOf(wrapped);
      if (index >= 0) disposers.splice(index, 1);
    };
    disposers.push(wrapped);
    return wrapped;
  }

  function addToList<T>(list: T[], fn: T): () => void {
    list.push(fn);
    return addDisposer(() => {
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    });
  }

  function activeStreamFn(): AgentStreamFn | undefined {
    const provider = streamFnProviders[streamFnProviders.length - 1];
    if (provider !== undefined) {
      return (request: AgentStreamRequest) => provider(request) as AsyncIterable<string>;
    }
    return baseStreamFn;
  }

  function toolNamesSnapshot(): readonly string[] {
    const names = new Set<string>();
    for (const item of contributions) {
      if (item.kind === "tool") names.add(item.tool.name);
    }
    for (const name of pluginTools.keys()) names.add(name);
    for (const name of declaredLoadout.keys()) names.add(name);
    return [...names];
  }

  const api: PluginApiSurface = {
    registerTool(tool) {
      const name = tool.name;
      if (typeof name !== "string" || name.length === 0) throw new Error("api.registerTool: name required");
      const existing = pluginTools.get(name);
      existing?.dispose();
      const dispose = addDisposer(() => {
        pluginTools.delete(name);
      });
      pluginTools.set(name, { tool, dispose });
      return dispose;
    },
    onEvent(handler) {
      return addDisposer(stream.subscribe(handler));
    },
    addConverter(fn) {
      return addToList(converters, fn);
    },
    addContextTransform(fn) {
      return addToList(contextTransforms, fn);
    },
    addBeforeToolCall(fn) {
      return addToList(beforeToolCalls, fn);
    },
    addAfterToolCall(fn) {
      return addToList(afterToolCalls, fn);
    },
    addTurnBoundary(fn) {
      return addToList(turnBoundaries, fn);
    },
    addPrepareRequest(fn) {
      return addToList(prepareRequestFns, fn);
    },
    addPrepareNextTurn(fn) {
      return addToList(prepareNextTurnFns, fn);
    },
    provideSteering(source) {
      return addToList(steeringSources, source);
    },
    provideFollowUp(source) {
      return addToList(followUpSources, source);
    },
    provideStreamFn(fn) {
      return addToList(streamFnProviders, fn);
    },
    declareToolLoadout(tools) {
      declaredLoadout.clear();
      for (const tool of tools) declaredLoadout.set(tool.name, tool);
    },
    useContext: () => options.coreContext,
    events,
    capabilities: () => securityBackend.capabilities(),
    onEffect: (handler) => effectBridge.onEffect(handler),
    addRedactor: (rule) => logger.addRedactor(rule),
    disposeAll() {
      for (const dispose of [...disposers].reverse()) dispose();
    },
  };

  // 兼容门面贡献的 hook 同样纳入 api 生命周期，由 disposeAll 撤销。
  for (const item of contributions) {
    if (item.kind !== "hook") continue;
    const handler: (event: AgentEvent) => void = item.handler;
    addDisposer(stream.subscribe((event) => {
      if (event.type === item.event) handler(event);
    }));
  }

  // 模型在纯文本流中用该标记请求工具调用（stub 期间尚无结构化 tool-call 通道）。
  const TOOL_MARKER_RE = /@@TOOL:([A-Za-z0-9_.:-]+):(.*?)@@/g;
  // 与 runLoop 的默认终局判断相反：无工具调用的单轮也应结束，而非显式续跑。
  const TURN_END_DECISION = { action: "end" } as const;
  // 工具结果仅回传本地执行信息，不重新进入模型（避免 stub 下的无限续跑）。
  const NO_TOOL_RESULT = "";

  /** 把已拼接的文本投影为 message_update 所需的流式部分快照。 */
  function textSnapshot(content: string): AssistantMessageEvent {
    return { type: "text_delta", delta: content };
  }

  async function runTurn(userText?: string): Promise<readonly AgentMessage[]> {
    if (aborted) return stream.getState().messages;
    await stream.emit({ type: "agent_start" });

    const inbox: Inbox = createInbox();
    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    for (const source of steeringSources) {
      inbox.steer(source.next() as AgentMessage);
    }
    for (const source of followUpSources) {
      inbox.followUp(source.next() as AgentMessage);
    }

    const toolRegistry = new Map<string, (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>>();
    for (const item of contributions) {
      if (item.kind !== "tool") continue;
      const tool = item.tool;
      toolRegistry.set(tool.name, (args) => (tool.execute as (input: never) => unknown)(args as never));
    }
    for (const [name, entry] of pluginTools) toolRegistry.set(name, (args) => (entry.tool.execute as (input: never) => unknown)(args as never));
    for (const [name, tool] of declaredLoadout) toolRegistry.set(name, (args) => (tool.execute as (input: never) => unknown)(args as never));

    const effectiveStreamFn = activeStreamFn();
    const emitConverted = (input: unknown): void => {
      for (const converter of converters) {
        const event = converter(input);
        if (event !== undefined) void stream.emit(event);
      }
    };

    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      prepareNextTurn: () => {
        for (const fn of prepareNextTurnFns) fn(stream.getState());
      },
      prepareRequest: (request) => {
        let result: unknown = request;
        for (const transform of contextTransforms) result = transform(result);
        for (const fn of prepareRequestFns) result = fn(result);
        return result;
      },
      pollFollowUp: () => inbox.poll("nextTurn").map((item) => item.body),
      finishTurn: (turn) => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        for (const fn of turnBoundaries) fn(event);
        return TURN_END_DECISION;
      },

      async streamAssistant(request: unknown): Promise<AssistantResult> {
        const updates: AssistantMessageEvent[] = [];
        let content = "";
        if (effectiveStreamFn !== undefined) {
          for await (const chunk of effectiveStreamFn(request as AgentStreamRequest)) {
            emitConverted(chunk);
            if (aborted) {
              return {
                message: { role: "assistant", content },
                toolCalls: [],
                stopReason: "aborted",
                updates,
              };
            }
            content += chunk;
            updates.push(textSnapshot(content));
          }
        }

        const toolCalls: ToolCall[] = [];
        if (!aborted) {
          for (const match of content.matchAll(TOOL_MARKER_RE)) {
            const name = match[1];
            if (name === undefined) continue;
            let args: unknown = {};
            try {
              args = JSON.parse(match[2] ?? "{}") as unknown;
            } catch {
              // 参数非法时按空对象处理，由工具实现决定如何拒绝。
            }
            toolCalls.push({ id: `call-${toolCalls.length + 1}`, name, args });
          }
        }

        return {
          message: { role: "assistant", content: content.replace(TOOL_MARKER_RE, "") },
          toolCalls,
          stopReason: aborted ? "aborted" : "stop",
          updates,
        };
      },

      async executeToolCalls(calls: readonly ToolCall[]): Promise<readonly ToolResult[]> {
        const results: ToolResult[] = [];
        for (const [index, call] of calls.entries()) {
          const updates = [{ partialResult: `executing ${call.name}` }];
          const execute = toolRegistry.get(call.name);
          let isError = false;
          let output: unknown = NO_TOOL_RESULT;
          if (execute === undefined) {
            isError = true;
            output = "TOOL_NOT_FOUND";
          } else if (aborted) {
            isError = true;
            output = "ABORTED";
          } else {
            try {
              const args = typeof call.args === "object" && call.args !== null
                ? (call.args as Readonly<Record<string, unknown>>)
                : {};
              for (const fn of beforeToolCalls) await fn({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
              const value = await execute(args);
              for (const fn of afterToolCalls) await fn({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: value, isError: false });
              output = value === undefined ? NO_TOOL_RESULT : value;
            } catch (error) {
              isError = true;
              output = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          results.push({
            callId: call.id || `call-${index + 1}`,
            message: { role: "toolResult", content: output },
            isError,
            updates,
          });
        }
        return results;
      },

    };

    await runLoop(runtime);
    return stream.getState().messages;
  }

  return {
    prompt(text) {
      if (typeof text !== "string") throw new Error("prompt: expected a string");
      return runTurn(text);
    },
    continue: () => runTurn(),
    subscribe: (listener) => stream.subscribe(listener),
    abort() {
      aborted = true;
    },
    waitForIdle: () => stream.waitForIdle(),
    ...api,
    api,
    emitEffect: (meta) => effectBridge.emit(meta),
    resolveLogSink: (options) => resolveLogSink(options),
    logger,
    async runTool(call) {
      if (isCriticalLayerDegraded(securityBackend.capabilities())) {
        return { ok: false, reason: "CRITICAL_LAYER_DEGRADED" };
      }
      try {
        await securityBackend.run({ argv: [call.name] });
        const value = await call.execute();
        return { ok: true, value };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    get aborted() {
      return aborted;
    },
    get state() {
      return stream.getState();
    },
    get toolNames() {
      return toolNamesSnapshot();
    },
    toolDefinitions,
    assembly,
  };
}
