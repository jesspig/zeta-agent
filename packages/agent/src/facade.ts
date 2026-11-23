import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEventStream,
  createInbox,
  declareToolChanges,
  runLoop,
  AgentPluginManager,
  type AgentEvent,
  type AgentListener,
  type AgentMessage,
  type AgentPlugin,
  type AgentPluginApi,
  type AgentState,
  type AgentToolCallRecord,
  type AssistantMessageEvent,
  type AssistantResult,
  type CompatExtensionApi,
  type ContextTransform,
  type Converter,
  type CoreContextLike,
  type DurableExtensionSpec,
  type EffectMeta,
  type EventBus,
  type FinishTurn,
  type Inbox,
  type LoopRuntime,
  type PluginContribution,
  type PluginTool,
  type PrepareNextTurn,
  type PrepareRequest,
  type QueueSource,
  type RedactRule,
  type StreamFn,
  type ToolCall,
  type ToolResult,
} from "@zeta-agent/agent-framework";
import type { Disposer } from "@zeta-agent/framework";
import type { PermissionGate } from "./plugins/permissions/guard";
import {
  createDurableEffects,
  type DurableEffects,
  type DurableIntent,
  type Receipt,
} from "./plugins/effects/durable";
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
  createEgressPolicy,
  createUnconnectedBackend,
  isCriticalLayerDegraded,
  isEgressAllowed,
  verifyAuditChain,
  type AuditRecord,
  type AuditSink,
  type CredentialVault,
  type EgressPolicy,
  type EgressTarget,
  type ExecutionBackend,
  type FinalizedState,
  type SecretBroker,
} from "@zeta-agent/security";
import { createProviderStreamFn } from "./providers/dispatch";

export type {
  AgentEvent,
  AgentListener,
  AgentMessage,
  AgentState,
  AgentToolCallRecord,
} from "@zeta-agent/agent-framework";

// 插件管线归位到 agent-framework；类型重导出不进入运行时导出面，保持旧路径零回归。
export type {
  AgentPlugin,
  AgentPluginManager,
  HookChain,
  CompatExtensionApi,
  DurableExtensionSpec,
  PluginContribution,
  PluginTool,
} from "@zeta-agent/agent-framework";
export { defineCompatExtension, defineDurableExtension } from "@zeta-agent/agent-framework";

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

/**
 * 默认 withhold 的发射工具清单：这些工具会改变外部世界，批次内先 enqueue，commit 才派发。
 * 只读工具（read/ls/grep/find 等）不在清单内，保持即时执行。
 */
const DEFAULT_EMISSION_TOOLS: readonly string[] = Object.freeze([
  "write",
  "edit",
  "bash",
  "powershell",
]);

function builtinTools(options: {
  readonly securityBackend: ExecutionBackend;
  readonly allowedDirectories: readonly string[];
}): ToolDefinition[] {
  return [...builtinToolDefinitions(options)];
}

export interface PluginApiSurface extends AgentPluginApi {
  /** 按 LIFO 撤销所有经 api 注册的贡献（含兼容门面贡献的 hook）。 */
  disposeAll(): void;
  /**
   * 把外部 disposer（例如 permission gate 的 declareTools / addBeforeToolCall
   * 返回值）纳入 facade 的生命周期撤销栈；返回幂等 disposer，按 LIFO 撤销。
   */
  trackDisposer(dispose: () => void): Disposer;
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

export interface AgentToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: "string" | "number" | "boolean";
    readonly description: string;
    readonly required?: boolean;
  }[];
}

/** provider 流式块：纯文本字符串为兼容形态；对象形态携带推理与工具调用。 */
export type AgentStreamChunk =
  | string
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id?: string;
      readonly name: string;
      /** JSON 字符串形式的参数。 */
      readonly arguments?: string;
    };

export interface AgentStreamRequest {
  readonly messages: readonly AgentMessage[];
  /** 本轮可用的工具 schema；provider 据此发送原生 function calling。 */
  readonly tools?: readonly AgentToolSchema[];
  /** 思考强度档位（如 low/medium/high/xhigh），由 provider 映射到原生字段。 */
  readonly reasoningEffort?: string;
  /** 本轮取消信号；provider 应传给 fetch 并在提前退出时释放 reader。 */
  readonly signal?: AbortSignal;
}

export type AgentStreamFn = (request: AgentStreamRequest) => AsyncIterable<AgentStreamChunk>;

function defaultSecurityBackend(): ExecutionBackend {
  // 未接入真实隔离执行器：能力声明为 unsupported，能力探测即失败关闭。
  // 不再把"未执行"伪装成 active 并报告成功。
  return createUnconnectedBackend({ name: "facade-default-placeholder" });
}

function defaultLoggerOptions(): LoggerOptions {
  return { runId: "agent", sink: () => {} };
}

/** 与 @zeta-agent/security 默认审计哈希一致（FNV-1a 32），用于本地链校验与摘要。 */
function stableHash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
}

/** 从发射工具参数推导 egress 目标；支持显式 target 或 url。无法推导时返回 undefined（fail-closed）。 */
function deriveEgressTarget(args: Readonly<Record<string, unknown>>): EgressTarget | undefined {
  const target = args.target;
  if (typeof target === "object" && target !== null) {
    const record = target as { readonly host?: unknown; readonly port?: unknown };
    if (typeof record.host === "string" && record.host.length > 0 && typeof record.port === "number") {
      return { host: record.host, port: record.port };
    }
  }
  const url = args.url;
  if (typeof url === "string" && url.length > 0) {
    try {
      const parsed = new URL(url);
      const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      return { host: parsed.hostname, port };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type EgressVerdict =
  | { readonly status: "none" }
  | { readonly status: "allowed"; readonly target: EgressTarget }
  | { readonly status: "denied" };

/**
 * 对所有工具调用统一做 egress 判定，而不只限发射工具。
 * 没有携带网络目标参数的调用无外联可校验（none）；
 * 一旦携带 url/target 却无法解析或未获策略允许，则 fail-closed 拒绝。
 */
function checkEgress(args: Readonly<Record<string, unknown>>, policy: EgressPolicy): EgressVerdict {
  const hasNetworkArg =
    typeof args.url === "string" ||
    (typeof args.target === "object" && args.target !== null);
  if (!hasNetworkArg) return { status: "none" };
  const target = deriveEgressTarget(args);
  if (target === undefined || !isEgressAllowed(policy, target)) return { status: "denied" };
  return { status: "allowed", target };
}

/** createProviderStreamFn 的 facade 投影；凭据由 Agent 注入，调用方无需重复传递。 */
export interface AgentProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface AuditFinalization {
  readonly configured: boolean;
  readonly finalized: FinalizedState | "not-configured";
  /** 仅当注入 auditDir 时给出落盘文件路径。 */
  readonly path?: string;
  readonly entries: number;
  readonly verified: boolean;
}

/** ASK 决策的确认请求：阶段、工具与参数交给注入方裁决。 */
export interface ConfirmRequest {
  readonly stage: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

/** 注入式确认通道：返回 true 表示批准 ASK；false 或抛错维持 fail-closed。 */
export interface ConfirmChannel {
  confirm(request: ConfirmRequest): Promise<boolean>;
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
  /** 系统提示词；缺省时注入 cwd/platform/tools 等运行环境信息。 */
  readonly systemPrompt?: string | (() => string);
  /** 初始思考强度档位（可被 setReasoningEffort 修改）。 */
  readonly reasoningEffort?: string;
  /**
   * 是否允许把 assistant 正文中的 @@TOOL:...@@ 文本标记解释为工具调用。
   * 默认 false：生产路径只接受结构化 tool_call，避免引用/回显正文获得工具权限。
   * 仅测试夹具或显式隔离的兼容宿主才应开启。
   */
  readonly allowTextToolMarkers?: boolean;
  /**
   * 可选权限门禁。仅显式注入时，工具执行前才调用 authorize 做按次判定；
   * 不注入时整条路径保持基线行为，与发射策略相互独立。
   */
  readonly permissionGate?: PermissionGate;
  /** 门禁 authorize 使用的阶段名；缺省 "plan"。 */
  readonly permissionStage?: string;
  /**
   * 可选 ASK 确认通道：注入后 ASK 决策经此通道确认；未注入时 ASK 维持 fail-closed（等同拒绝）。
   * DENY 决策不受影响，始终拒绝。
   */
  readonly confirmChannel?: ConfirmChannel;
  /**
   * 发射策略：默认 "withhold"（发射类工具批次内 enqueue、commit 统一派发）；
   * "direct" 是兼容开关，完全绕过 withhold，保持 T-06 之前的直接执行行为。
   */
  readonly emissionPolicy?: "withhold" | "direct";
  /**
   * 可选持久副作用：命中发射工具时改为 enqueue，批次结束后 commit 统一派发。
   * 缺省且策略为 withhold 时，facade 自动创建默认 DurableEffects（dispatcher 调用原始工具执行）。
   */
  readonly durableEffects?: DurableEffects;
  /**
   * egress 门禁：缺省即默认拒绝（无任何 allow 规则）；
   * 对所有工具调用生效，非发射工具的外联目标同样受控。
   */
  readonly egressPolicy?: EgressPolicy;
  /** 视作发射工具的工具名集合；缺省时由 emissionPolicy 决定（withhold 用默认清单，direct 为空）。 */
  readonly emissionTools?: readonly string[];
  /** 可选凭据保管库，需与 secretBroker 成对注入才启用占位符路径。 */
  readonly credentialVault?: CredentialVault;
  /** 可选凭据代理，需与 credentialVault 成对注入才启用占位符路径。 */
  readonly secretBroker?: SecretBroker;
  /** 可选审计链：仅注入时为拒绝/发射/工具执行写 AuditRecord。 */
  readonly auditSink?: AuditSink;
  /** 可选审计落盘目录：配合 finalizeAudit(revision) 写带完整性标记的链文件。 */
  readonly auditDir?: string;
}

export interface Agent extends PluginApiSurface {
  prompt(text: string): Promise<readonly AgentMessage[]>;
  continue(): Promise<readonly AgentMessage[]>;
  /** 运行中注入 steer 消息：下一轮轮首进入 transcript，无需等待新 prompt。 */
  steer(message: AgentMessage): void;
  /** 运行中注入 followUp 消息：按队列语义留到下一次轮首消费。 */
  followUp(message: AgentMessage): void;
  subscribe(listener: AgentListener): Disposer;
  abort(): void;
  /** 新建会话：清空会话上下文与在途状态，保留事件订阅。 */
  reset(): void;
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
  readonly reasoningEffort: string | undefined;
  setReasoningEffort(effort: string | undefined): void;
  /** 发射回执快照：durableEffects 的真实回执 + egress 拒绝的失败回执。 */
  emissionReceipts(): readonly Receipt[];
  /** 把审计链与 finalized(revision) 结果写入 auditDir（若注入），返回可校验的完整性信息。 */
  finalizeAudit(revision: number): AuditFinalization;
  /** 用 AgentOptions 注入的凭据组件创建 provider 流；未注入时保持 dispatch 默认行为。 */
  createProviderStreamFn(config: AgentProviderConfig, fetchImpl?: typeof fetch): AgentStreamFn;
}

export function createAgent(options: AgentOptions = {}): Agent {
  const stream = createEventStream();
  const baseStreamFn = options.streamFn;
  let reasoningEffort: string | undefined = options.reasoningEffort;
  const allowTextToolMarkers = options.allowTextToolMarkers === true;
  const includeBuiltins = options.includeBuiltins !== false;
  const plugins = options.plugins ?? [];
  const securityBackend = options.securityBackend ?? defaultSecurityBackend();
  const permissionGate = options.permissionGate;
  const permissionStage = options.permissionStage ?? "plan";
  const confirmChannel = options.confirmChannel;
  const allowedDirectories = options.allowedDirectories ?? [];
  const emissionPolicy = options.emissionPolicy ?? "withhold";
  const emissionTools = new Set(
    options.emissionTools ?? (emissionPolicy === "direct" ? [] : DEFAULT_EMISSION_TOOLS)
  );
  const withholdEnabled = emissionPolicy !== "direct" && emissionTools.size > 0;
  /** 默认发射工具的真实执行入口；每次 runTurn 重建工具表后立即刷新。 */
  let activeToolRegistry: ReadonlyMap<string, (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>> = new Map();
  // D6（延期）：框架 createToolPipeline 原语可用，facade 当前仅装配 declareToolChanges 声明 hook；
  // 完整以 toolPipeline 替换 executeToolCalls 涉及权限/withhold/durable 逻辑耦合，按 O-03 裁决延期。
  /** 只有未注入 durableEffects 且启用 withhold 时，才为默认清单创建内置效果。 */
  const usesDefaultEffects = options.durableEffects === undefined && withholdEnabled;
  const durableEffects = options.durableEffects ?? (usesDefaultEffects ? createDefaultEmissionEffects() : undefined);
  // 未注入策略时采用默认拒绝：没有显式 allow 规则，任何可推导的外联目标都被挡下。
  const egressPolicy = options.egressPolicy ?? createEgressPolicy();
  const credentialVault = options.credentialVault;
  const secretBroker = options.secretBroker;
  const auditSink = options.auditSink;
  const auditDir = options.auditDir;
  /** egress 拒绝等未进入 durableEffects 的失败回执，供调用方观测。 */
  const failedEmissionReceipts: Receipt[] = [];

  /** 默认发射效果的 dispatcher：派发时才调用当前回合的原始工具执行。 */
  function createDefaultEmissionEffects(): DurableEffects {
    return createDurableEffects(async (intent: DurableIntent) => {
      const payload = intent.payload as {
        readonly tool: string;
        readonly args: Readonly<Record<string, unknown>>;
      };
      const execute = activeToolRegistry.get(payload.tool);
      if (execute === undefined) return { ok: false, error: `EMISSION_TOOL_NOT_FOUND: ${payload.tool}` };
      try {
        return await execute(payload.args);
      } catch (error) {
        // 与基线 executeToolCalls 的 catch 一致：异常转成结构化失败结果，保持工具对外契约零回归。
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  function recordAudit(toolName: string, argsDigest: string, decision: string, resultDigest: string, causalId: string): void {
    if (auditSink === undefined) return;
    const record: AuditRecord = {
      ts: Date.now(),
      actor: "agent",
      tenant: "default",
      pluginId: "facade",
      toolName,
      argsDigest,
      decision,
      resultDigest,
      causalId,
    };
    auditSink.append(record);
  }
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

  const toolNamesForPrompt = toolDefinitions.map((tool) => tool.name);
  function resolveSystemPrompt(): string {
    if (typeof options.systemPrompt === "function") return options.systemPrompt();
    if (typeof options.systemPrompt === "string" && options.systemPrompt.length > 0) return options.systemPrompt;
    const lines = [
      "You are zeta, an interactive coding agent running in the user's terminal.",
      "",
      "Environment:",
      `- Current working directory: ${process.cwd()}`,
      `- Platform: ${process.platform}`,
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      toolNamesForPrompt.length > 0 ? `- Available tools: ${toolNamesForPrompt.join(", ")}` : "",
      "",
      "Guidelines:",
      "- Use the provided tools whenever the answer depends on files, directories, commands, or other system state.",
      "- Do not invent file contents, paths, or command output; inspect them with tools first.",
      "- File tool paths must be absolute and inside the current working directory.",
      "- Answer environment questions (cwd, platform, git status, etc.) from the Environment section or by calling tools.",
      "- Reply in the same language the user uses. Keep answers concise and concrete.",
    ].filter((line) => line.length > 0);
    return lines.join("\n");
  }

  const logger = createLogger(options.observability ?? defaultLoggerOptions());
  const effectBridge = options.effectBridge ?? createEffectBridge();
  const fiberLogger = logger.forFiber("agent");

  stream.subscribe((event) => {
    const content = "message" in event ? String(event.message.content) : event.type;
    fiberLogger.info(`${event.type} ${content}`);
  });

  let aborted = false;
  /** 当前回合的取消控制器；abort() 触发它，使等待中的网络请求立即结束。 */
  let abortController: AbortController | undefined;
  /** 当前回合是否使用了 provider 原生 tool_calls（决定是否自动续跑消费工具结果）。 */
  let lastTurnHadNativeTools = false;

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
  // 插件生命周期（有序注册 / 幂等 disposer / LIFO 撤销）由 agent-framework 的核心管线提供。
  const pluginManager = new AgentPluginManager();
  const events = createEventBus();
  /** 持久 inbox：外部可在运行中 steer()/followUp()，由下一轮轮首统一 poll。 */
  const inbox: Inbox = createInbox();

  function addDisposer(dispose: () => void): () => void {
    return pluginManager.addDisposer(dispose);
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

  /** 上一次声明的工具名；只有集合真的变化时才向 transcript 注入 system 声明。 */
  let declaredToolNames: readonly string[] = [...toolNamesSnapshot()];

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
    trackDisposer(dispose) {
      return addDisposer(dispose);
    },
    disposeAll() {
      pluginManager.disposeAll();
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

  /** 把内置工具的简化参数表投影为 provider 可用的工具描述。 */
  function toToolSchema(tool: ToolDefinition): AgentToolSchema {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  /** 把已拼接的文本投影为 message_update 所需的流式部分快照。 */
  function textSnapshot(content: string): AssistantMessageEvent {
    return { type: "text_delta", delta: content };
  }

  async function runTurn(userText?: string): Promise<readonly AgentMessage[]> {
    aborted = false;
    abortController = new AbortController();
    if (userText === undefined && stream.getState().messages.length === 0) return stream.getState().messages;
    await stream.emit({ type: "agent_start" });

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
    activeToolRegistry = toolRegistry;

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
      declareToolChanges: () => {
        const next = toolNamesSnapshot();
        const delta = declareToolChanges(declaredToolNames, next);
        declaredToolNames = next;
        // 权限策略热更新不改变工具集合时返回 undefined，避免无意义的 system 声明/reload。
        return delta.messages.length > 0 ? delta : undefined;
      },
      prepareRequest: (request) => {
        const base = (request ?? {}) as { readonly messages?: readonly AgentMessage[] };
        const prompt = resolveSystemPrompt();
        // 系统提示词只进入请求，不写入会话状态，避免 transcript 出现 system 行。
        const seeded = {
          ...(request as object),
          messages:
            prompt.length > 0 && base.messages?.[0]?.role !== "system"
              ? [{ role: "system" as const, content: prompt }, ...(base.messages ?? [])]
              : (base.messages ?? []),
        };
        let result: unknown = seeded;
        for (const transform of contextTransforms) result = transform(result);
        for (const fn of prepareRequestFns) result = fn(result);
        return result;
      },
      pollFollowUp: () => inbox.poll("nextTurn").map((item) => item.body),
      finishTurn: (turn) => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        for (const fn of turnBoundaries) fn(event);
        // 原生工具调用需要续跑一轮，让模型消费工具结果；文本标记协议保持单轮收束。
        return lastTurnHadNativeTools && turn.toolResults.length > 0 ? undefined : TURN_END_DECISION;
      },

      async streamAssistant(
        request: unknown,
        onPartial?: (message: AgentMessage) => void | Promise<void>,
      ): Promise<AssistantResult> {
        const updates: AssistantMessageEvent[] = [];
        let content = "";
        let thinking = "";
        const streamedCalls: Array<{ id?: string; name: string; arguments?: string }> = [];
        lastTurnHadNativeTools = false;
        let partialSeq = 0;
        const snapshot = (): AgentMessage => ({
          role: "assistant",
          content,
          ...(thinking.length > 0 ? { thinking } : {}),
        });
        if (effectiveStreamFn !== undefined) {
          const base = (request ?? {}) as Partial<AgentStreamRequest>;
          const enriched: AgentStreamRequest = {
            ...base,
            messages: base.messages ?? [],
            tools: base.tools ?? toolDefinitions.map(toToolSchema),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            signal: abortController?.signal,
          } as AgentStreamRequest;
          for await (const chunk of effectiveStreamFn(enriched)) {
            if (aborted) {
              return {
                message: snapshot(),
                toolCalls: [],
                stopReason: "aborted",
                updates,
              };
            }
            if (typeof chunk === "string") {
              emitConverted(chunk);
              content += chunk;
            } else if (chunk.type === "text") {
              content += chunk.text;
            } else if (chunk.type === "reasoning") {
              emitConverted(chunk.text);
              thinking += chunk.text;
            } else if (chunk.type === "tool_call") {
              streamedCalls.push(chunk);
            }
            if (onPartial !== undefined && (content.length > 0 || thinking.length > 0)) {
              partialSeq += 1;
              await onPartial(snapshot());
              updates.push({ type: "text_delta", delta: content, seq: partialSeq });
            }
          }
        }

        const toolCalls: ToolCall[] = [];
        const records: AgentToolCallRecord[] = [];
        lastTurnHadNativeTools = streamedCalls.length > 0;
        if (!aborted) {
          for (const call of streamedCalls) {
            const id = call.id ?? `call-${toolCalls.length + 1}`;
            let args: unknown = {};
            try {
              args = JSON.parse(call.arguments ?? "{}") as unknown;
            } catch {
              // 参数流式拼装失败时按空对象处理，由工具实现拒绝。
            }
            toolCalls.push({ id, name: call.name, args });
            records.push({ id, name: call.name, arguments: call.arguments ?? JSON.stringify(args) });
          }
          // 文本标记是可选的兼容通道：默认关闭，正文中的标记保持为普通文本，
          // 不进入工具执行路径；只有显式 opt-in 时才解析并消费标记。
          if (allowTextToolMarkers) {
            for (const match of content.matchAll(TOOL_MARKER_RE)) {
              const name = match[1];
              if (name === undefined) continue;
              let args: unknown = {};
              try {
                args = JSON.parse(match[2] ?? "{}") as unknown;
              } catch {
                // 参数非法时按空对象处理，由工具实现决定如何拒绝。
              }
              const id = `call-${toolCalls.length + 1}`;
              toolCalls.push({ id, name, args });
              records.push({ id, name, arguments: match[2] ?? "{}" });
            }
          }
        }

        return {
          message: {
            role: "assistant",
            content: allowTextToolMarkers ? content.replace(TOOL_MARKER_RE, "") : content,
            ...(thinking.length > 0 ? { thinking } : {}),
            ...(records.length > 0 ? { toolCalls: records } : {}),
          },
          toolCalls,
          stopReason: aborted ? "aborted" : "stop",
          // 增量已在流式过程中通过 onPartial 发出，避免重复。
          updates: onPartial === undefined ? updates : [],
        };
      },

      async executeToolCalls(calls: readonly ToolCall[]): Promise<readonly ToolResult[]> {
        const results: ToolResult[] = [];
        /** 已 enqueue 的工具调用位次 → 幂等键，commit 后据此回填真实执行结果。 */
        const emissionSlots = new Map<number, string>();
        let enqueuedEmission = false;
        for (const [index, call] of calls.entries()) {
          const updates = [{ partialResult: `executing ${call.name}` }];
          const execute = toolRegistry.get(call.name);
          let isError = false;
          let output: unknown = NO_TOOL_RESULT;
          let denialReason: string | undefined;
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
              const argsDigest = stableHash(JSON.stringify(args));
              const isEmission = withholdEnabled && durableEffects !== undefined && emissionTools.has(call.name);
              let denied = false;
              if (permissionGate !== undefined) {
                // 每次执行都读取 gate 当前状态：增删 hook / declareTools 后立即生效，无需 reload。
                const decision = await permissionGate.authorize(permissionStage, call.name, args);
                if (decision.behavior !== "ALLOW") {
                  const reason = decision.reason ?? "PERMISSION_DENIED";
                  // DENY 始终拒绝；ASK 仅在注入确认通道且确认通过时放行，否则维持 fail-closed。
                  const approved = decision.behavior === "ASK" && confirmChannel !== undefined
                    ? await confirmChannel.confirm({
                        stage: permissionStage,
                        tool: call.name,
                        args,
                        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
                      })
                    : false;
                  if (!approved) {
                    denied = true;
                    isError = true;
                    output = {
                      ok: false,
                      error: "PERMISSION_DENIED",
                      reason,
                      stage: permissionStage,
                      tool: call.name,
                    };
                    denialReason = `PERMISSION_DENIED: ${reason}`;
                    recordAudit(call.name, argsDigest, "PERMISSION_DENIED", reason, call.id ?? "");
                    // 审计走既有机制：logger 写 sink，loop 随后发带 isError 的 tool_execution_end。
                    fiberLogger.warn(`PERMISSION_DENIED stage=${permissionStage} tool=${call.name} reason=${reason}`);
                  } else {
                    recordAudit(call.name, argsDigest, "ASK_APPROVED", reason, call.id ?? "");
                  }
                }
              }
              if (!denied) {
                const verdict = checkEgress(args, egressPolicy);
                if (verdict.status === "denied") {
                  // egress 默认拒绝覆盖所有路径：发射工具写失败回执，非发射工具直接拒绝执行。
                  isError = true;
                  denialReason = "EGRESS_DENIED";
                  const key = `${call.name}:${argsDigest}`;
                  recordAudit(call.name, argsDigest, "EGRESS_DENIED", "EGRESS_DENIED", call.id ?? "");
                  if (isEmission) {
                    const receipt: Receipt = { kind: call.name, key, ok: false, value: { error: "EGRESS_DENIED" } };
                    failedEmissionReceipts.push(receipt);
                    output = { ok: false, error: "EGRESS_DENIED", tool: call.name, key };
                  } else {
                    output = { ok: false, error: "EGRESS_DENIED", tool: call.name };
                  }
                } else if (isEmission) {
                  // 发射工具：事务内只 enqueue，真实副作用留到批次结束的 commit 统一派发。
                  const key = `${call.name}:${argsDigest}`;
                  durableEffects.enqueue(call.name, key, {
                    tool: call.name,
                    args,
                    ...(verdict.status === "allowed" ? { target: verdict.target } : {}),
                  });
                  emissionSlots.set(index, key);
                  enqueuedEmission = true;
                  recordAudit(call.name, argsDigest, "EMISSION_WITHHELD", key, call.id ?? "");
                  output = { ok: true, withheld: true, tool: call.name, key };
                } else {
                  // 非发射工具（或 direct 策略）走原路径，行为与基线完全一致。
                  for (const fn of beforeToolCalls) await fn({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
                  const value = await execute(args);
                  // 工具以 {ok:false} 表达的失败也要传播为 isError，不能只靠抛错。
                  const failed = typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
                  if (failed) isError = true;
                  for (const fn of afterToolCalls) await fn({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: value, isError: failed });
                  output = value === undefined ? NO_TOOL_RESULT : value;
                  recordAudit(
                    call.name,
                    argsDigest,
                    failed || isError ? "TOOL_FAILED" : "TOOL_EXECUTED",
                    stableHash(JSON.stringify(output ?? "")),
                    call.id ?? ""
                  );
                }
              }
            } catch (error) {
              isError = true;
              output = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          results.push({
            callId: call.id || `call-${index + 1}`,
            message: {
              role: "toolResult",
              content: output,
              toolCallId: call.id || `call-${index + 1}`,
              toolName: call.name,
            },
            isError,
            ...(denialReason !== undefined ? { reason: denialReason } : {}),
            updates,
          });
        }
        // 工具批次结束：统一 commit，副作用只在此刻发生；重复 (kind,key) 由 durableEffects 去重。
        if (enqueuedEmission && durableEffects !== undefined) {
          const receipts = await durableEffects.commit();
          const byKey = new Map(receipts.map((receipt) => [receipt.key, receipt]));
          for (const receipt of receipts) {
            recordAudit(receipt.kind, receipt.key, receipt.ok ? "EMISSION_DISPATCHED" : "EMISSION_FAILED", receipt.ok ? "OK" : "FAILED", receipt.key);
          }
          if (usesDefaultEffects) {
            // 默认发射工具对外仍呈现真实执行结果，避免改变既有工具的返回契约。
            return results.map((result, index) => {
              const key = emissionSlots.get(index);
              const receipt = key === undefined ? undefined : byKey.get(key);
              const message = result.message;
              if (receipt === undefined || message === undefined) return result;
              const value = receipt.value;
              const failed = typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
              return {
                ...result,
                isError: !receipt.ok || failed,
                message: {
                  ...message,
                  content: receipt.ok
                    ? (value === undefined ? NO_TOOL_RESULT : value)
                    : { ok: false, error: "EMISSION_DISPATCH_FAILED", key },
                },
              };
            });
          }
        }
        return results;
      },

    };

    try {
      await runLoop(runtime);
    } catch (error) {
      const message: AgentMessage = {
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
      await stream.emit({ type: "message_start", message });
      await stream.emit({ type: "message_end", message });
      await stream.emit({ type: "agent_end", messages: stream.getState().messages });
    }
    return stream.getState().messages;
  }

  return {
    prompt(text) {
      if (typeof text !== "string") throw new Error("prompt: expected a string");
      return runTurn(text);
    },
    continue: () => runTurn(),
    steer: (message) => {
      inbox.steer(message);
    },
    followUp: (message) => {
      inbox.followUp(message);
    },
    // D11（延期）：框架 createCompactionListener 原语可用；facade 自动装配需要注入
    // surface/offloader 并补齐零回归测试，当前保持调用方自行订阅，按 O-03 延期。
    subscribe: (listener) => stream.subscribe(listener),
    abort() {
      aborted = true;
      abortController?.abort();
    },
    reset() {
      aborted = false;
      abortController = undefined;
      lastTurnHadNativeTools = false;
      inbox.clear("nextTurn");
      inbox.clear("nextStep");
      stream.reset();
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
    get reasoningEffort() {
      return reasoningEffort;
    },
    setReasoningEffort(effort) {
      reasoningEffort = effort;
    },
    emissionReceipts() {
      return [...(durableEffects?.receipts() ?? []), ...failedEmissionReceipts];
    },
    finalizeAudit(revision) {
      if (auditSink === undefined) {
        return { configured: false, finalized: "not-configured", entries: 0, verified: false };
      }
      const finalized = auditSink.finalized(revision);
      const entries = auditSink.entries;
      const verified = verifyAuditChain(entries, stableHash);
      if (auditDir === undefined) {
        return { configured: true, finalized, entries: entries.length, verified };
      }
      mkdirSync(auditDir, { recursive: true });
      const path = join(auditDir, `audit-final-${revision}.json`);
      const payload = {
        schema: "zeta-audit-chain/v1",
        revision,
        finalized,
        entries,
        integrity: {
          marker: "AUDIT_CHAIN_SEALED_V1",
          seq: entries.length,
          head: entries.length > 0 ? entries[entries.length - 1]!.hash : "0",
          verified,
        },
      };
      writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
      return { configured: true, finalized, path, entries: entries.length, verified };
    },
    createProviderStreamFn(config, fetchImpl) {
      return createProviderStreamFn(
        {
          ...config,
          ...(credentialVault !== undefined ? { credentialVault } : {}),
          ...(secretBroker !== undefined ? { secretBroker } : {}),
        },
        fetchImpl
      );
    },
  };
}
