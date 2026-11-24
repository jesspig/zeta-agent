import {
  createEventStream,
  createInbox,
  declareToolChanges,
  runLoop,
  AgentPluginManager,
  createPluginRegistry,
  createContributionHost,
  DEFAULT_PLUGIN_REALM,
  createBudgetTracker,
  createCompactionListener,
  createMemoryWorkspaceStore,
  createOffloader,
  createSessionSurface,
  type CompactionBudget,
  type CompactionEvent,
  type CompactionLineage,
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
  type CoreLoopHooks,
  type DurableExtensionSpec,
  type BudgetTracker,
  type EffectMeta,
  type Offloader,
  type SessionSurface,
  type WorkspaceStore,
  type EventBus,
  type FinishTurn,
  type Inbox,
  type LoopRuntime,
  type PluginContribution,
  type PluginMetadata,
  type ContributionContext,
  type ContributionExecutors,
  type PluginTool,
  type PrepareNextTurn,
  type PrepareRequest,
  type QueueSource,
  type RedactRule,
  type StreamFn,
  type ToolCall,
  type ToolResult,
} from "@zeta-agent/agent-framework";
import {
  createToolPipeline,
  createToolRegistry,
  type BeforeToolCallHook,
  type AfterToolCallHook,
  type ToolDescriptor,
  type ToolPublisher,
} from "@zeta-agent/agent-framework";
import {
  createPluginTransaction,
  reviewExtension,
  DEFAULT_EXTENSION_POLICY,
  type Disposer,
  type ExtensionPolicy,
  type ExtensionSource,
  type ExtensionReview,
} from "@zeta-agent/framework";
import type { PermissionGate } from "./plugins/permissions/guard";
import {
  createApprovalBroker,
  type ApprovalChannel,
  type ApprovalState,
} from "./plugins/permissions/approval";
import {
  evaluatePermissionPolicy,
  type PermissionPolicy,
} from "./plugins/permissions/policy";
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
  createLocalSafeBackend,
  createProfileBackend,
  createSocketAuditSink,
  isCriticalLayerDegraded,
  isEgressAllowed,
  resolveStructuredBackend,
  verifyAuditChain,
  type AuditRecord,
  type AuditSink,
  type BackendProfile,
  type SocketAuditSink,
  type CredentialBoundaryRef,
  type CredentialVault,
  type EgressPolicy,
  type EgressTarget,
  type ExecutionBackend,
  type FinalizedState,
  type SecretBroker,
  type StructuredExecutionBackend,
} from "@zeta-agent/security";
import { createProviderStreamFn } from "./providers/dispatch";
import { builtinIdsForProfile, resolveAssemblyProfile, type AssemblyProfile } from "./assembly/builtins";
import { createAssemblyManifest, type CapabilityDiagnostic } from "./assembly/manifest";
import { diagnoseCapabilities, executableToolNames } from "./assembly/profile";
import type { SessionStore } from "./session/store";
import type { TenantScope } from "./tenant/governance";

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

/** 默认装配清单来自真实 BUILTIN_PLUGINS 注册表，不再手写 skills/session/mode。 */
export const DEFAULT_ASSEMBLY: readonly string[] = builtinIdsForProfile("local-safe");

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
  readonly structuredBackend?: StructuredExecutionBackend;
}): ToolDefinition[] {
  return [...builtinToolDefinitions(options)];
}

export interface WrapRegistrationOptions extends PluginMetadata {
  readonly handler?: (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

export interface TaskRegistrationOptions extends PluginMetadata {
  readonly handler?: () => void | Promise<void>;
}

/** 贡献在真实注册入口中的投影，供宿主观察与测试。 */
export interface ContributionSnapshot {
  readonly name: string;
  readonly text: string | undefined;
  readonly value: unknown;
  readonly order: number;
  readonly realm: symbol;
  readonly replaceable: boolean;
  readonly required: boolean;
  readonly generation: number;
}

/** install() 原样 disposer 与审查结论一并留档。 */
export interface PluginInstallation {
  readonly plugin: AgentPlugin;
  readonly generation: number;
  readonly dispose: Disposer;
  readonly realm: symbol;
  readonly review: ExtensionReview;
}

export interface PluginReviewRecord {
  readonly plugin: AgentPlugin;
  readonly review: ExtensionReview;
}

export interface PluginApiSurface extends AgentPluginApi {
  /** 按 LIFO 撤销所有经 api 注册的贡献（含兼容门面贡献的 hook）。 */
  disposeAll(): void;
  /**
   * 把外部 disposer（例如 permission gate 的 declareTools / addBeforeToolCall
   * 返回值）纳入 facade 的生命周期撤销栈；返回幂等 disposer，按 LIFO 撤销。
   */
  trackDisposer(dispose: () => void): Disposer;
  /**
   * 声明插件贡献的发射工具名（引用计数，多次声明独立撤销）；与 options.emissionTools
   * 合并后由 facade 的 withhold/durable 路径统一派发，插件不另开副作用直通路径。
   */
  declareEmissionTools(names: readonly string[]): Disposer;
  /** section 贡献进入系统提示词，按 order 排序、按 realm 隔离。 */
  addSection(text: string, options?: PluginMetadata): Disposer;
  /** wrap 贡献进入工具执行链，handler 在工具调用前后被调用。 */
  addWrap(name: string, options?: WrapRegistrationOptions): Disposer;
  /** task 贡献在 agent_start 作为后台作业执行，可按需手动 runTask。 */
  addTask(name: string, options?: TaskRegistrationOptions): Disposer;
  /** service 贡献进入服务注册表，可由 resolveService 解析。 */
  addService(name: string, value?: unknown, options?: PluginMetadata): Disposer;
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
export type AgentStopReason = "stop" | "length" | "error" | "aborted";

export interface AgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly [key: string]: unknown;
}

export interface AgentStreamError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly responseId?: string;
}

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
    }
  | {
      readonly type: "done";
      readonly stopReason: AgentStopReason;
      readonly usage?: AgentUsage;
      readonly durationMs?: number;
      readonly responseId?: string;
    }
  | {
      readonly type: "error";
      readonly error: AgentStreamError;
      readonly durationMs?: number;
      readonly responseId?: string;
    };

export interface AgentStreamRequest {
  readonly messages: readonly AgentMessage[];
  /** broker 路由使用的显式 provider；省略时按 model 前缀或 routes 解析。 */
  readonly provider?: string;
  /** broker 路由使用的模型引用；具体 provider 适配器仍使用各自构造配置。 */
  readonly model?: string;
  /** 本轮可用的工具 schema；provider 据此发送原生 function calling。 */
  readonly tools?: readonly AgentToolSchema[];
  /** 思考强度档位（如 low/medium/high/xhigh），由 provider 映射到原生字段。 */
  readonly reasoningEffort?: string;
  /** 本轮取消信号；provider 应传给 fetch 并在提前退出时释放 reader。 */
  readonly signal?: AbortSignal;
}

export type AgentStreamFn = (request: AgentStreamRequest) => AsyncIterable<AgentStreamChunk>;

function defaultSecurityBackend(
  allowedDirectories: readonly string[],
  profile: BackendProfile
): ExecutionBackend {
  // local-safe 是真实的结构化文件边界；进程隔离层保持 unsupported 并失败关闭。
  // 其他 profile 未接真实执行器时明确声明 unsupported/degraded，绝不伪装 active。
  if (profile === "local-safe") return createLocalSafeBackend({ allowedDirectories });
  return createProfileBackend(profile, { allowedDirectories });
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
  /** 保留字段以兼容旧调用方；facade 不再自行写旁路文件，socket 模式永远不设置。 */
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
  readonly pluginManager?: AgentPluginManager;
  /** 不可信扩展的来源/digest/capability 审查策略；缺省禁用不可信扩展。 */
  readonly pluginPolicy?: ExtensionPolicy;
  readonly loopHooks?: CoreLoopHooks;
  readonly includeBuiltins?: boolean;
  readonly securityBackend?: ExecutionBackend;
  /** 后端档位：local-safe（默认，真实结构化文件边界）或沙箱档位（未接线时失败关闭）。 */
  readonly backendProfile?: BackendProfile;
  /** 产品 profile：local-safe 默认收敛，local-full 显式 opt-in；只控制暴露范围，不伪造能力。 */
  readonly assemblyProfile?: AssemblyProfile;
  /**
   * 本 agent 实际安装的服务名；由统一装配 manifest 注入。
   * 缺省时按 assemblyProfile 从注册表派生，避免 facade 与 manifest 手写清单漂移。
   */
  readonly services?: readonly string[];
  /** 显式注入结构化后端；优先于 securityBackend 的兼容解析。 */
  readonly structuredBackend?: StructuredExecutionBackend;
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
  /** 统一 credential boundary（IF-11）：provider 创建时优先级高于 vault 对。 */
  readonly credentialBoundary?: CredentialBoundaryRef;
  /** 可选审计链：仅注入时为拒绝/发射/工具执行写 AuditRecord。 */
  readonly auditSink?: AuditSink;
  /** 权限策略 AST：与 gate 叠加，restrict 单调收紧，override 不可提升 bypass-immune 拒绝。 */
  readonly permissionPolicy?: PermissionPolicy;
  /** 四态审批通道；未注入时 ASK 保持 fail-closed（confirmChannel 作为兼容适配器）。 */
  readonly approvalChannel?: ApprovalChannel;
  /** 单次 run 的 provider 回合上限。 */
  readonly turnBudget?: number;
  /** 工具调用缺省超时（毫秒）；工具自身 timeoutMs 优先。 */
  readonly toolTimeoutMs?: number;
  /**
   * 审计传输形态：默认 "memory" 保持零回归；"socket" 走进程外 daemon（仅含端点，不含密钥）。
   * 仅当未注入 auditSink 时生效。
   */
  readonly auditTransport?: "memory" | "socket";
  /** socket 模式的本地端点（unix:路径 或 tcp:host:port），绝不传签名密钥。 */
  readonly auditEndpoint?: string;
  /** socket 模式的客户端认证令牌；缺省从 AUDIT_CLIENT_TOKEN_ENV 读取，不进产物。 */
  readonly auditToken?: string;
  /** @deprecated facade 不再自行写无签名旁路文件；落盘由 daemon 独占。 */
  readonly auditDir?: string;
  /** 可选会话存储：agent_end 的 newMessages 在 awaited listener 中逐条落盘后再 resolve prompt。 */
  readonly sessionStore?: SessionStore;
  /**
   * 租户治理作用域（由 principal resolver 解析得到）：注入后 session/provider/effects/quota/audit
   * 全部按该 realm 解析；未注入时保持原有单租户行为。
   */
  readonly tenantScope?: TenantScope;
  /**
   * 可选压缩装配：surface/offloader 由 facade 创建并随 agent_end 落 SessionStore；
   * 不注入时压缩路径完全不启用，保持既有调用方零回归。
   */
  readonly compaction?: AgentCompactionOptions;
}

export interface AgentCompactionOptions {
  readonly budget: CompactionBudget;
  /** 可注入自定义 surface（缺省新建内存 surface）。 */
  readonly surface?: SessionSurface;
  /** 可注入自定义 offloader 或 workspace store。 */
  readonly offloader?: Offloader;
  readonly workspaceStore?: WorkspaceStore;
  /** 传给默认 offloader 的输出字节上限。 */
  readonly maxOutputBytes?: number;
  /** started/completed/failed/interrupted 事件；facade 同时把它们写入审计链。 */
  readonly emit?: (event: CompactionEvent) => void | Promise<void>;
}

export interface AgentCompactionHandle {
  readonly surface: SessionSurface;
  readonly offloader: Offloader;
  readonly budgetTracker: BudgetTracker;
}

export interface Agent extends PluginApiSurface {
  prompt(text: string, signal?: AbortSignal): Promise<readonly AgentMessage[]>;
  continue(signal?: AbortSignal): Promise<readonly AgentMessage[]>;
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
  readonly assemblyProfile: AssemblyProfile;
  /** 能力诊断：每个 builtin 工具/后端操作/关键层的真实状态。 */
  readonly capabilityDiagnostics: readonly CapabilityDiagnostic[];
  /** 最终 active registry 中可供模型选择的工具名（可执行或显式注入）。 */
  readonly activeToolNames: readonly string[];
  readonly reasoningEffort: string | undefined;
  setReasoningEffort(effort: string | undefined): void;
  /** 发射回执快照：durableEffects 的真实回执 + egress 拒绝的失败回执。 */
  emissionReceipts(): readonly Receipt[];
  /** 内存/注入 sink 的同步封存；socket 模式抛错，须改用 finalizeAuditAsync。 */
  finalizeAudit(revision: number): AuditFinalization;
  /** socket 模式：由 daemon 封存标记并跨进程校验；非 socket 模式等价 finalizeAudit。 */
  finalizeAuditAsync(revision: number): Promise<AuditFinalization>;
  /** 关闭与审计 daemon 的连接；非 socket 模式为空操作。 */
  closeAudit(): Promise<void>;
  /** 用 AgentOptions 注入的凭据组件创建 provider 流；未注入时保持 dispatch 默认行为。 */
  createProviderStreamFn(config: AgentProviderConfig, fetchImpl?: typeof fetch): AgentStreamFn;
  readonly sessionStore: SessionStore | undefined;
  readonly compaction: AgentCompactionHandle | undefined;
  /** 本 agent 绑定的租户作用域；单租户调用方为 undefined。 */
  readonly tenantScope: TenantScope | undefined;
  /** 通过审查并安装的插件：dispose 为 install() 原样返回的 disposer。 */
  readonly pluginInstallations: readonly PluginInstallation[];
  /** 全部候选插件的审查结论（含被禁用的）。 */
  readonly pluginReviews: readonly PluginReviewRecord[];
  readonly pluginSections: readonly ContributionSnapshot[];
  readonly pluginWraps: readonly ContributionSnapshot[];
  readonly pluginTasks: readonly ContributionSnapshot[];
  readonly pluginServices: readonly ContributionSnapshot[];
  readonly pluginGeneration: number;
  resolveService(name: string, realm?: symbol): unknown;
  runTask(name: string, realm?: symbol): Promise<void>;
  providerToolSchemas(): readonly AgentToolSchema[];
}

function streamErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return error instanceof Error ? error.message : String(error);
}

export function createAgent(options: AgentOptions = {}): Agent {
  const stream = createEventStream();
  const tenantScope = options.tenantScope;
  const sessionStore = tenantScope?.sessionStore ?? options.sessionStore;
  if (sessionStore !== undefined) {
    // agent_end 只含本次 newMessages；事件流 await listener，故 prompt resolve 前消息已落盘。
    stream.subscribe(async (event) => {
      if (event.type !== "agent_end") return;
      for (const item of event.messages) await sessionStore.append(item);
    });
  }
  const baseStreamFn = tenantScope?.streamFn ?? options.streamFn;
  let reasoningEffort: string | undefined = options.reasoningEffort;
  const allowTextToolMarkers = options.allowTextToolMarkers === true;
  const includeBuiltins = options.includeBuiltins !== false;
  const plugins = options.plugins ?? [];
  const allowedDirectories = options.allowedDirectories ?? [];
  const backendProfile = options.backendProfile ?? "local-safe";
  const securityBackend =
    options.securityBackend ?? defaultSecurityBackend(allowedDirectories, backendProfile);
  const structuredBackend =
    options.structuredBackend ?? resolveStructuredBackend(securityBackend, allowedDirectories);
  const assemblyProfile = resolveAssemblyProfile(options.assemblyProfile);
  const capabilityDiagnostics = diagnoseCapabilities(
    assemblyProfile,
    securityBackend.capabilities(),
    structuredBackend.operations
  );
  const permissionGate = options.permissionGate;
  const permissionStage = options.permissionStage ?? "plan";
  const confirmChannel = options.confirmChannel;
  const approvalBroker = createApprovalBroker(options.approvalChannel);
  const permissionPolicy = options.permissionPolicy;
  let approvalSeq = 0;
  let runToolSeq = 0;
  const nextApprovalId = (): string => `approval-${++approvalSeq}`;
  const emissionPolicy = options.emissionPolicy ?? "withhold";
  const baseEmissionTools = options.emissionTools ?? (emissionPolicy === "direct" ? [] : DEFAULT_EMISSION_TOOLS);
  const pluginEmissionRefs = new Map<string, number>();
  let emissionTools = new Set(baseEmissionTools);
  const recomputeEmissionTools = (): void => {
    emissionTools = new Set([...baseEmissionTools, ...pluginEmissionRefs.keys()]);
  };
  let activeSignal: AbortSignal | undefined;
  let activePipeline: ReturnType<typeof createToolPipeline> | undefined;
  /** 发射工具在 commit 阶段经同一管线派发，此时不再重复 enqueue。 */
  let dispatchingEmission = false;
  /** withhold 策略下总是创建默认效果：插件（如 MCP）可在装配后声明发射工具。 */
  const injectedEffects = tenantScope?.durableEffects ?? options.durableEffects;
  const usesDefaultEffects = injectedEffects === undefined && emissionPolicy !== "direct";
  const durableEffects = injectedEffects ?? (usesDefaultEffects ? createDefaultEmissionEffects() : undefined);
  const isEmissionTool = (name: string): boolean =>
    emissionPolicy !== "direct" && durableEffects !== undefined && emissionTools.has(name);
  // 未注入策略时采用默认拒绝：没有显式 allow 规则，任何可推导的外联目标都被挡下。
  const egressPolicy = options.egressPolicy ?? createEgressPolicy();
  const credentialVault = options.credentialVault;
  const secretBroker = options.secretBroker;
  const credentialBoundary = options.credentialBoundary;
  const auditTransport = options.auditTransport ?? "memory";
  const auditEndpoint = options.auditEndpoint;
  if (auditTransport === "socket" && (typeof auditEndpoint !== "string" || auditEndpoint.length === 0)) {
    throw new Error("AUDIT_ENDPOINT_REQUIRED");
  }
  const socketSink: SocketAuditSink | undefined =
    auditTransport === "socket" && options.auditSink === undefined
      ? createSocketAuditSink({ endpoint: auditEndpoint!, ...(options.auditToken === undefined ? {} : { token: options.auditToken }) })
      : undefined;
  if (socketSink !== undefined) void socketSink.ready().catch(() => {});
  const auditSink: AuditSink | undefined = options.auditSink ?? socketSink;
  /** egress 拒绝等未进入 durableEffects 的失败回执，供调用方观测。 */
  const failedEmissionReceipts: Receipt[] = [];

  /** 默认发射效果的 dispatcher：派发时才调用当前回合的原始工具执行。 */
  function createDefaultEmissionEffects(): DurableEffects {
    return createDurableEffects(async (intent: DurableIntent) => {
      const payload = intent.payload as {
        readonly tool: string;
        readonly args: Readonly<Record<string, unknown>>;
      };
      if (activePipeline === undefined) return { ok: false, error: "TOOL_PIPELINE_UNAVAILABLE" };
      try {
        if (activeSignal?.aborted === true) throw new Error("ABORTED");
        // commit 阶段仍走统一管线（权限/审批/钩子/cleanup），但不再二次 enqueue。
        dispatchingEmission = true;
        const result = await activePipeline.runToolCall({
          id: `emission:${payload.tool}:${intent.key}`,
          tool: payload.tool,
          input: payload.args,
        });
        if (result.isError === true) {
          return { ok: false, error: String(result.reason ?? "EMISSION_FAILED") };
        }
        return result.output;
      } catch (error) {
        // 与基线 executeToolCalls 的 catch 一致：异常转成结构化失败结果，保持工具对外契约零回归。
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        dispatchingEmission = false;
      }
    });
  }

  function recordAudit(toolName: string, argsDigest: string, decision: string, resultDigest: string, causalId: string): void {
    if (auditSink === undefined) return;
    const record: AuditRecord = {
      ts: Date.now(),
      actor: tenantScope?.principal.userId ?? "agent",
      tenant: tenantScope?.principal.spaceId ?? "default",
      pluginId: "facade",
      toolName,
      argsDigest,
      decision,
      resultDigest,
      causalId,
    };
    auditSink.append(record);
  }

  // 压缩装配复用 SessionStore 的 appendRecap 血缘与 agent_end 屏障，不另建会话协议。
  const compactionOptions = options.compaction;
  const compaction: AgentCompactionHandle | undefined = compactionOptions === undefined
    ? undefined
    : (() => {
        const surface = compactionOptions.surface ?? createSessionSurface();
        const offloader = compactionOptions.offloader ?? createOffloader(
          compactionOptions.workspaceStore ?? createMemoryWorkspaceStore(),
          compactionOptions.maxOutputBytes === undefined ? {} : { maxOutputBytes: compactionOptions.maxOutputBytes }
        );
        return { surface, offloader, budgetTracker: createBudgetTracker(compactionOptions.budget) };
      })();
  let persistedLineageCount = 0;
  async function persistCompaction(lineages: readonly CompactionLineage[]): Promise<void> {
    if (sessionStore === undefined) return;
    for (const lineage of lineages.slice(persistedLineageCount)) {
      await sessionStore.appendRecap(lineage.recap, lineage.uris, {
        threshold: lineage.threshold,
        preTokenCount: lineage.preTokenCount,
      });
    }
    persistedLineageCount = lineages.length;
  }
  async function emitCompaction(event: CompactionEvent): Promise<void> {
    if (compactionOptions?.emit !== undefined) await compactionOptions.emit(event);
    if (auditSink === undefined) return;
    recordAudit(
      "compaction",
      stableHash(JSON.stringify({ threshold: "threshold" in event ? event.threshold : 0, preTokenCount: event.preTokenCount })),
      event.type,
      stableHash(JSON.stringify(event)),
      `compaction:${event.preTokenCount}`
    );
  }
  if (compaction !== undefined) {
    // 已完成消息进入 surface；system 提示词只进请求，由 recap.objective 逐字承接。
    stream.subscribe((event) => {
      if (event.type === "message_end") compaction.surface.append(event.message);
    });
  }

  /** ASK 决策统一走四态审批通道；confirmChannel 仅作为布尔兼容适配器。 */
  async function resolveApproval(
    stage: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    reason: string | undefined,
    toolSignal: AbortSignal | undefined
  ): Promise<{ readonly approved: boolean; readonly state: ApprovalState }> {
    if (options.approvalChannel !== undefined) {
      const decision = await approvalBroker.request(
        {
          requestId: nextApprovalId(),
          stage,
          tool,
          args,
          ...(reason !== undefined ? { reason } : {}),
        },
        toolSignal ?? activeSignal
      );
      return { approved: decision.allowed, state: decision.state };
    }
    if (confirmChannel !== undefined) {
      try {
        const approved = await confirmChannel.confirm({
          stage,
          tool,
          args,
          ...(reason !== undefined ? { reason } : {}),
        });
        return { approved, state: approved ? "allowed-once" : "rejected" };
      } catch {
        return { approved: false, state: "unavailable" };
      }
    }
    return { approved: false, state: "unavailable" };
  }

  function localFinalization(revision: number): AuditFinalization {
    if (auditSink === undefined) return { configured: false, finalized: "not-configured", entries: 0, verified: false };
    const finalized = auditSink.finalized(revision);
    const entries = auditSink.entries;
    return { configured: true, finalized, entries: entries.length, verified: verifyAuditChain(entries, stableHash) };
  }

  const toolDefinitions = includeBuiltins
    ? builtinTools({ securityBackend, allowedDirectories, structuredBackend })
    : [];
  // 只有 builtin 工具走静态 contributions；插件与服务都经真实注册入口（安装事务 + registry）。
  const contributions: PluginContribution[] = includeBuiltins
    ? toolDefinitions.map((tool) => ({ kind: "tool", tool }))
    : [];
  // 服务清单由统一装配 manifest 注入；缺省时仍从注册表派生，保持 SDK/CLI 一致。
  const defaultManifest = createAssemblyManifest({ profile: assemblyProfile });
  const serviceNames = options.services ?? [...defaultManifest.services, ...defaultManifest.session];

  /** 插件世代：staging 固定世代，commit 时过期项被丢弃；贡献记录各自世代。 */
  const defaultRealm = tenantScope?.realm ?? DEFAULT_PLUGIN_REALM;
  let pluginGeneration = 0;
  const sectionRegistry = createPluginRegistry<{ readonly text: string }>();
  const wrapRegistry = createPluginRegistry<NonNullable<WrapRegistrationOptions["handler"]>>();
  const taskRegistry = createPluginRegistry<NonNullable<TaskRegistrationOptions["handler"]>>();
  const serviceRegistry = createPluginRegistry<unknown>();
  const pluginInstallations: PluginInstallation[] = [];
  const pluginReviews: PluginReviewRecord[] = [];

  const assembly = includeBuiltins ? builtinIdsForProfile(assemblyProfile) : [];

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
    // section 贡献是真实提示词的一部分，按注册入口的 order 排序后追加。
    const sections = sectionRegistry.snapshot().map((slot) => slot.value.text);
    if (sections.length > 0) lines.push("", "Plugin sections:", ...sections);
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
  let generation = 0;
  interface RunLease {
    readonly generation: number;
    readonly controller: AbortController;
    promise: Promise<readonly AgentMessage[]>;
  }
  let activeRun: RunLease | undefined;
  /** 当前回合是否使用了 provider 原生 tool_calls（决定是否自动续跑消费工具结果）。 */
  let lastTurnHadNativeTools = false;

  // 插件 API 的可变注册集合。每个 add* 返回幂等 disposer；disposeAll 按 LIFO 撤销。
  interface PluginToolEntry {
    readonly tool: PluginTool;
    readonly token: object;
    readonly meta: ContributionContext;
    readonly dispose: () => void;
  }
  const pluginTools = new Map<string, PluginToolEntry>();
  const declaredLoadout = new Map<string, PluginTool>();
  const converters: Converter[] = [];
  const contextTransforms: ContextTransform[] = [];
  const beforeToolCalls: Array<(event: AgentEvent, signal?: AbortSignal) => void | Promise<void>> = [];
  const afterToolCalls: Array<(event: AgentEvent, signal?: AbortSignal) => void | Promise<void>> = [];
  const turnBoundaries: FinishTurn[] = [];
  const prepareRequestFns: PrepareRequest[] = [];
  const prepareNextTurnFns: PrepareNextTurn[] = [];
  const steeringSources: QueueSource[] = [];
  const followUpSources: QueueSource[] = [];
  const streamFnProviders: StreamFn[] = [];
  // 插件生命周期（有序注册 / 幂等 disposer / LIFO 撤销）由 agent-framework 的核心管线提供。
  const pluginManager = options.pluginManager ?? new AgentPluginManager();
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

  /** 同名工具替换：旧条目先撤销，新条目用身份 disposer 登记，旧 disposer 晚到不误删。 */
  function registerToolEntry(tool: PluginTool, meta: Partial<ContributionContext> = {}): Disposer {
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) throw new Error("api.registerTool: name required");
    const existing = pluginTools.get(name);
    if (existing !== undefined) {
      if (existing.meta.required || meta.required === true) throw new Error(`REQUIRED_ROOT_REPLACED: ${name}`);
      if (!existing.meta.replaceable) throw new Error(`REPLACE_REJECTED: ${name}`);
      existing.dispose();
    }
    const token = {};
    const entryMeta: ContributionContext = {
      realm: meta.realm ?? defaultRealm,
      order: meta.order ?? 100,
      generation: meta.generation ?? pluginGeneration,
      replaceable: meta.replaceable ?? true,
      required: meta.required ?? false,
      source: meta.source,
      ...(meta.digest === undefined ? {} : { digest: meta.digest }),
      ...(meta.capabilities === undefined ? {} : { capabilities: meta.capabilities }),
      trusted: meta.trusted ?? false,
    };
    const dispose = addDisposer(() => {
      if (pluginTools.get(name)?.token === token) pluginTools.delete(name);
    });
    pluginTools.set(name, { tool, token, meta: entryMeta, dispose });
    return dispose;
  }

  let sectionSequence = 0;
  const installationContributionDisposers = new Map<PluginInstallation, Disposer[]>();
  const contributionExecutors: ContributionExecutors = {
    tool: (item, ctx) => registerToolEntry(item.tool, ctx),
    hook: (item, ctx) =>
      stream.subscribe((event) => {
        if (event.type === item.event) item.handler(event);
      }),
    section: (item, ctx) =>
      sectionRegistry.register({
        name: `section:${String(ctx.realm.description ?? "realm")}:${sectionSequence++}`,
        value: { text: item.text },
        realm: ctx.realm,
        order: ctx.order,
        replaceable: ctx.replaceable,
        required: ctx.required,
        source: ctx.source,
      }),
    wrap: (item, ctx) =>
      wrapRegistry.register({
        name: item.name,
        value: item.handler ?? (() => undefined),
        realm: ctx.realm,
        order: ctx.order,
        replaceable: ctx.replaceable,
        required: ctx.required,
        source: ctx.source,
      }),
    task: (item, ctx) =>
      taskRegistry.register({
        name: item.name,
        value: item.handler ?? (() => undefined),
        realm: ctx.realm,
        order: ctx.order,
        replaceable: ctx.replaceable,
        required: ctx.required,
        source: ctx.source,
      }),
    service: (item, ctx) =>
      serviceRegistry.register({
        name: item.name,
        value: item.value,
        realm: ctx.realm,
        order: ctx.order,
        replaceable: ctx.replaceable,
        required: ctx.required,
        source: ctx.source,
      }),
  };
  const contributionHost = createContributionHost(contributionExecutors, {
    defaultRealm,
    generation: () => pluginGeneration,
  });

  // 装配清单中的 builtin 服务走同一注册入口；显式 require 且不可替换。
  if (includeBuiltins) {
    for (const name of serviceNames) {
      addDisposer(contributionHost.apply(
        { kind: "service", name, value: undefined },
        { realm: defaultRealm, order: 0, replaceable: false, required: true, source: "builtin", trusted: true }
      ));
    }
  }

  /** staging → validate → commit；失败即 discard，install() 原样 disposer 逐插件留档。 */
  const pluginPolicy = options.pluginPolicy ?? DEFAULT_EXTENSION_POLICY;
  const stage = createPluginTransaction<AgentPlugin>({ generation: () => pluginGeneration });
  const stagedInputs = [];
  for (const plugin of plugins) {
    // 宿主显式传入的插件对象按贡献内容生成 digest；标记外部来源的插件必须自带 digest。
    const hostDigest = plugin.source === undefined
      ? `host:${stableHash(JSON.stringify({
          name: plugin.name,
          version: plugin.version,
          contributions: plugin.contributions.map((item) =>
            `${item.kind}:${"name" in item ? String(item.name) : "text" in item ? String(item.text) : ""}`),
        }))}`
      : undefined;
    const source: ExtensionSource = {
      origin: (plugin.source as ExtensionSource["origin"]) ?? "user",
      digest: plugin.digest ?? hostDigest,
      ...(plugin.capabilities === undefined ? {} : { capabilities: plugin.capabilities }),
      // 宿主显式传入且未标记来源的插件视为可信；标记外部来源但未 trusted 的由策略裁决。
      trusted: plugin.trusted ?? (plugin.source === undefined),
    };
    const review = reviewExtension(source, pluginPolicy);
    pluginReviews.push({ plugin, review });
    if (review.decision === "denied") continue;
    stagedInputs.push({
      item: plugin,
      meta: {
        name: plugin.name,
        realm: plugin.realm ?? defaultRealm,
        order: plugin.order ?? 100,
        replaceable: plugin.replaceable ?? true,
        required: plugin.required ?? false,
        source: plugin.source,
        digest: plugin.digest,
        capabilities: plugin.capabilities,
        trusted: review.decision === "allowed",
      },
    });
  }
  stage.stage(stagedInputs);
  const validationIssues = stage.validate();
  if (validationIssues.length > 0) {
    throw new Error(`PLUGIN_VALIDATION_FAILED: ${validationIssues.map((issue) => issue.reason).join(",")}`);
  }
  const installResult = stage.commit({
    install: (entry) => {
      pluginGeneration += 1;
      return entry.item.install();
    },
    apply: (entry, record) => {
      const generation = pluginGeneration;
      const installation: PluginInstallation = {
        plugin: entry.item,
        generation,
        dispose: record.dispose,
        realm: entry.realm ?? defaultRealm,
        review: pluginReviews.find((item) => item.plugin === entry.item)?.review
          ?? { decision: "allowed", reason: "TRUSTED", source: { origin: "user", trusted: true } },
      };
      pluginInstallations.push(installation);
      const contributionDisposers: Disposer[] = [];
      installationContributionDisposers.set(installation, contributionDisposers);
      addDisposer(record.dispose);
      for (const item of entry.item.contributions) {
        // 沙箱扩展只保留提示词/事件观察能力；工具、任务、服务与 wrap 一概不授予。
        if (!entry.trusted && item.kind !== "section" && item.kind !== "hook") continue;
        const stop = contributionHost.apply(item, {
          realm: item.realm ?? entry.realm ?? defaultRealm,
          order: item.order ?? entry.order,
          replaceable: item.replaceable ?? entry.replaceable,
          required: item.required ?? entry.required,
          source: item.source ?? entry.source,
          digest: item.digest ?? entry.digest,
          capabilities: item.capabilities ?? entry.capabilities,
          trusted: item.trusted ?? entry.trusted,
          generation,
        });
        const tracked = addDisposer(stop);
        contributionDisposers.push(tracked);
      }
    },
    unapply: (_entry, record) => {
      const index = pluginInstallations.findIndex((item) => item.dispose === record.dispose);
      const installation = index >= 0 ? pluginInstallations[index] : undefined;
      if (installation === undefined) return;
      for (const stop of installationContributionDisposers.get(installation) ?? []) stop();
      installationContributionDisposers.delete(installation);
      pluginInstallations.splice(index, 1);
    },
  });
  if (installResult.error !== undefined) throw installResult.error;

  function activeStreamFn(): AgentStreamFn | undefined {
    const provider = streamFnProviders[streamFnProviders.length - 1];
    if (provider !== undefined) {
      return (request: AgentStreamRequest) => provider(request) as AsyncIterable<AgentStreamChunk>;
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

  /** 最终 active registry：能力不支持的 builtin 被排除，显式注入的插件工具默认可执行。 */
  function activeToolNamesSnapshot(): readonly string[] {
    // 显式注入的插件工具默认可执行；builtin 仍受真实能力诊断约束。
    const pluginNames = new Set([...pluginTools.keys(), ...declaredLoadout.keys()]);
    const builtins = toolDefinitions.map((tool) => tool.name).filter((name) => !pluginNames.has(name));
    return [...executableToolNames(builtins, capabilityDiagnostics), ...pluginNames];
  }

  /** 上一次声明的工具名；只有集合真的变化时才向 transcript 注入 system 声明。 */
  let declaredToolNames: readonly string[] = [...toolNamesSnapshot()];

  const api: PluginApiSurface = {
    registerTool(tool) {
      return registerToolEntry(tool);
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
    declareEmissionTools(names) {
      const added = [...new Set(names)];
      for (const name of added) pluginEmissionRefs.set(name, (pluginEmissionRefs.get(name) ?? 0) + 1);
      recomputeEmissionTools();
      let armed = true;
      return addDisposer(() => {
        if (!armed) return;
        armed = false;
        for (const name of added) {
          const count = pluginEmissionRefs.get(name) ?? 0;
          if (count <= 1) pluginEmissionRefs.delete(name);
          else pluginEmissionRefs.set(name, count - 1);
        }
        recomputeEmissionTools();
      });
    },
    addSection(text, options = {}) {
      return addDisposer(contributionHost.apply(
        { kind: "section", text },
        { ...options, realm: options.realm ?? defaultRealm }
      ));
    },
    addWrap(name, options = {}) {
      const { handler, ...meta } = options;
      return addDisposer(contributionHost.apply(
        { kind: "wrap", name, ...(handler === undefined ? {} : { handler }) },
        { ...meta, realm: meta.realm ?? defaultRealm }
      ));
    },
    addTask(name, options = {}) {
      const { handler, ...meta } = options;
      return addDisposer(contributionHost.apply(
        { kind: "task", name, ...(handler === undefined ? {} : { handler }) },
        { ...meta, realm: meta.realm ?? defaultRealm }
      ));
    },
    addService(name, value, options = {}) {
      return addDisposer(contributionHost.apply(
        { kind: "service", name, value },
        { ...options, realm: options.realm ?? defaultRealm }
      ));
    },
    disposeAll() {
      pluginManager.disposeAll();
      pluginInstallations.length = 0;
      installationContributionDisposers.clear();
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

  /** provider schema 从最终 active registry 生成，未支持工具不进入模型可见面。 */
  function providerToolSchemas(): AgentToolSchema[] {
    const active = new Set(activeToolNamesSnapshot());
    // 同名后到者覆盖先到者：插件替换 builtin 后 schema 不再出现旧条目。
    const schemas = new Map<string, AgentToolSchema>();
    for (const tool of toolDefinitions) {
      if (active.has(tool.name)) schemas.set(tool.name, toToolSchema(tool));
    }
    const addPluginTool = (tool: PluginTool): void => {
      if (!active.has(tool.name)) return;
      schemas.set(tool.name, { name: tool.name, description: tool.name, parameters: [] });
    };
    for (const entry of pluginTools.values()) addPluginTool(entry.tool);
    for (const tool of declaredLoadout.values()) addPluginTool(tool);
    return [...schemas.values()];
  }

  /** 把已拼接的文本投影为 message_update 所需的流式部分快照。 */
  function textSnapshot(content: string): AssistantMessageEvent {
    return { type: "text_delta", delta: content };
  }

  function startRun(userText: string | undefined, externalSignal?: AbortSignal): Promise<readonly AgentMessage[]> {
    if (activeRun !== undefined) throw new Error("ACTIVE_RUN: 同一 Agent 同时只能运行一个 prompt/continue");
    const controller = new AbortController();
    const onAbort = (): void => {
      aborted = true;
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted === true) onAbort();
    else externalSignal?.addEventListener("abort", onAbort, { once: true });
    const lease: RunLease = { generation: ++generation, controller, promise: Promise.resolve([]) };
    activeRun = lease;
    aborted = false;
    lastTurnHadNativeTools = false;
    const execution = executeRun(lease, userText).finally(() => {
      externalSignal?.removeEventListener("abort", onAbort);
      if (activeRun === lease) activeRun = undefined;
    });
    lease.promise = execution;
    return execution;
  }

  async function executeRun(lease: RunLease, userText?: string): Promise<readonly AgentMessage[]> {
    const signal = lease.controller.signal;
    const initialMessageCount = stream.getState().messages.length;
    activeSignal = signal;
    if (userText === undefined && stream.getState().messages.length === 0) return stream.getState().messages;
    await stream.emit({ type: "agent_start" }, signal);
    // task 贡献作为后台作业在轮首执行（失败不影响主流程，由 hook chain 归一化）。
    for (const slot of taskRegistry.snapshot()) {
      try {
        await slot.value?.();
      } catch (error) {
        fiberLogger.warn(`plugin task ${slot.name} failed: ${String(error)}`);
      }
    }

    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    for (const source of steeringSources) {
      inbox.steer(await source.next() as AgentMessage);
    }
    for (const source of followUpSources) {
      inbox.followUp(await source.next() as AgentMessage);
    }

    const toolRegistry = new Map<string, (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => unknown | Promise<unknown>>();
    for (const item of contributions) {
      if (item.kind !== "tool") continue;
      const tool = item.tool;
      toolRegistry.set(tool.name, (args, toolSignal) => (tool.execute as (input: never, signal?: AbortSignal) => unknown)(args as never, toolSignal));
    }
    for (const [name, entry] of pluginTools) toolRegistry.set(name, (args, toolSignal) => (entry.tool.execute as (input: never, signal?: AbortSignal) => unknown)(args as never, toolSignal));
    for (const [name, tool] of declaredLoadout) toolRegistry.set(name, (args, toolSignal) => (tool.execute as (input: never, signal?: AbortSignal) => unknown)(args as never, toolSignal));
    /** 发射工具 callId → durable key，commit 后由 publisher 回填真实结果。 */
    const emissionSlots = new Map<string, string>();
    let commitPromise: Promise<readonly Receipt[]> | undefined;
    let committed: Map<string, Receipt> | undefined;
    const publisher: ToolPublisher = async (result) => {
      if (emissionSlots.size === 0 || durableEffects === undefined) return result;
      if (committed === undefined) {
        // 并行 finalize 会同时触发 publisher；单次 commit 必须共享同一个 in-flight promise。
        if (commitPromise === undefined) commitPromise = durableEffects.commit();
        const receipts = await commitPromise;
        committed = new Map(receipts.map((receipt) => [receipt.key, receipt]));
        for (const receipt of receipts) {
          if (!receipt.ok) tenantScope?.quota.release(1);
          recordAudit(
            receipt.kind,
            receipt.key,
            receipt.ok ? "EMISSION_DISPATCHED" : "EMISSION_FAILED",
            receipt.ok ? "OK" : "FAILED",
            receipt.key
          );
        }
      }
      if (!usesDefaultEffects) return result;
      const key = emissionSlots.get(result.callId);
      const receipt = key === undefined ? undefined : committed.get(key);
      if (receipt === undefined) return result;
      const value = receipt.value;
      const failed = typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
      const content = receipt.ok
        ? value === undefined ? NO_TOOL_RESULT : value
        : { ok: false, error: "EMISSION_DISPATCH_FAILED", key };
      const message = result.message ?? {
        role: "toolResult" as const,
        content,
        toolCallId: result.callId,
        toolName: result.tool ?? "",
      };
      return {
        ...result,
        isError: !receipt.ok || failed,
        output: content,
        message: { ...message, content },
      };
    };

    const before: BeforeToolCallHook = async (input, toolSignal) => {
      const name = input.tool;
      const args = input.args;
      const argsDigest = stableHash(JSON.stringify(args));
      if (toolSignal?.aborted === true || activeSignal?.aborted === true) {
        return { block: true, reason: "ABORTED" };
      }
      if (permissionGate !== undefined) {
        const decision = await permissionGate.authorize(permissionStage, name, args);
        if (decision.behavior !== "ALLOW") {
          const reason = decision.reason ?? "PERMISSION_DENIED";
          let approved = false;
          let state: ApprovalState = "unavailable";
          if (decision.behavior === "ASK") {
            const resolved = await resolveApproval(permissionStage, name, args, reason, toolSignal);
            approved = resolved.approved;
            state = resolved.state;
          }
          if (!approved) {
            const decisionName = state === "cancelled" ? "PERMISSION_CANCELLED" : "PERMISSION_DENIED";
            recordAudit(name, argsDigest, decisionName, reason, input.call.id);
            fiberLogger.warn(`${decisionName} stage=${permissionStage} tool=${name} reason=${reason}`);
            return { block: true, reason: `PERMISSION_DENIED: ${reason}` };
          }
          recordAudit(name, argsDigest, "ASK_APPROVED", reason, input.call.id);
        }
      }
      if (permissionPolicy !== undefined) {
        const verdict = evaluatePermissionPolicy(permissionPolicy, {
          stage: permissionStage,
          tool: name,
          input: args,
        });
        if (verdict.behavior === "DENY" || verdict.behavior === "ASK") {
          let approved = false;
          if (verdict.behavior === "ASK") {
            approved = (await resolveApproval(permissionStage, name, args, verdict.reason, toolSignal)).approved;
          }
          if (!approved) {
            const reason = verdict.reason ?? "POLICY_DENIED";
            recordAudit(name, argsDigest, `TOOL_POLICY_${verdict.behavior}`, reason, input.call.id);
            return { block: true, reason: `TOOL_POLICY_${verdict.behavior}: ${reason}` };
          }
        }
      }
      const egress = checkEgress(args, egressPolicy);
      if (egress.status === "denied") {
        const key = `${name}:${argsDigest}`;
        recordAudit(name, argsDigest, "EGRESS_DENIED", "EGRESS_DENIED", input.call.id);
        if (isEmissionTool(name)) {
          failedEmissionReceipts.push({ kind: name, key, ok: false, value: { error: "EGRESS_DENIED" } });
        }
        return { block: true, reason: "EGRESS_DENIED" };
      }
      if (isEmissionTool(name) && durableEffects !== undefined && !dispatchingEmission) {
        emissionSlots.set(input.call.id, `${name}:${argsDigest}`);
      }
      for (const fn of beforeToolCalls) {
        await fn(
          { type: "tool_execution_start", toolCallId: input.call.id, toolName: name, args },
          toolSignal ?? signal
        );
      }
      // wrap 贡献形成按 order 排序的环绕链，工具调用前依次执行。
      for (const slot of wrapRegistry.snapshot()) {
        await slot.value?.(
          { type: "tool_execution_start", toolCallId: input.call.id, toolName: name, args },
          toolSignal ?? signal
        );
      }
      return {};
    };

    const after: AfterToolCallHook = async (input, toolSignal) => {
      const name = input.call.tool ?? input.call.name ?? "";
      if (!isEmissionTool(name)) {
        const args = input.call.input ?? input.call.args ?? {};
        const argsDigest = stableHash(JSON.stringify(args));
        recordAudit(
          name,
          argsDigest,
          input.isError ? "TOOL_FAILED" : "TOOL_EXECUTED",
          stableHash(JSON.stringify(input.output ?? "")),
          input.call.id
        );
      }
      for (const fn of afterToolCalls) {
        await fn(
          {
            type: "tool_execution_end",
            toolCallId: input.call.id,
            toolName: input.call.tool ?? input.call.name ?? "",
            result: input.output,
            isError: input.isError,
          },
          toolSignal ?? signal
        );
      }
      const endEvent = {
        type: "tool_execution_end" as const,
        toolCallId: input.call.id,
        toolName: name,
        result: input.output,
        isError: input.isError,
      };
      for (const slot of [...wrapRegistry.snapshot()].reverse()) {
        await slot.value?.(endEvent, toolSignal ?? signal);
      }
    };

    const pipelineRegistry = createToolRegistry();
    for (const [name, execute] of toolRegistry) {
      const pipelineTool: ToolDescriptor = {
        name,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        execute: (args, exec) => {
          if (exec.signal?.aborted === true) throw new Error("ABORTED");
          const digest = stableHash(JSON.stringify(args));
          exec.onUpdate(`executing ${name}`);
          if (isEmissionTool(name) && durableEffects !== undefined && !dispatchingEmission) {
            const key = `${name}:${digest}`;
            // 配额是 coeffect：withhold 入队前先在本 realm 的 QuotaService 原子 reserve。
            const quota = tenantScope?.quota;
            if (quota !== undefined) {
              const request = { tool: name, tokens: 1 };
              if (!quota.check(request) || !quota.reserve(request)) {
                recordAudit(name, digest, "QUOTA_DENIED", "QUOTA_EXHAUSTED", key);
                throw new Error("QUOTA_EXHAUSTED");
              }
            }
            const verdict = checkEgress(args, egressPolicy);
            durableEffects.enqueue(name, key, {
              tool: name,
              args,
              ...(verdict.status === "allowed" ? { target: verdict.target } : {}),
            });
            recordAudit(name, digest, "EMISSION_WITHHELD", key, "pending");
            return { ok: true, withheld: true, tool: name, key };
          }
          return execute(args, exec.signal);
        },
      };
      pipelineRegistry.registerTool(pipelineTool);
    }
    activePipeline = createToolPipeline({
      registry: pipelineRegistry,
      signal,
      beforeToolCall: before,
      afterToolCall: after,
      publisher,
      timeoutMs: options.toolTimeoutMs,
    });

    const effectiveStreamFn = activeStreamFn();
    const emitConverted = async (input: unknown): Promise<void> => {
      for (const converter of converters) {
        const event = await converter(input);
        if (event !== undefined) await stream.emit(event, signal);
      }
    };

    const runtime: LoopRuntime = {
      inbox,
      signal,
      turnBudget: options.turnBudget,
      emit: (event) => stream.emit(event, signal),
      getState: () => stream.getState(),
      prepareNextTurn: async () => {
        for (const fn of prepareNextTurnFns) await fn(stream.getState(), signal);
        await options.loopHooks?.prepareNextTurn?.(stream.getState(), signal);
      },
      declareToolChanges: () => {
        const next = toolNamesSnapshot();
        const delta = declareToolChanges(declaredToolNames, next);
        declaredToolNames = next;
        // 权限策略热更新不改变工具集合时返回 undefined，避免无意义的 system 声明/reload。
        return delta.messages.length > 0 ? delta : undefined;
      },
      prepareRequest: async (request) => {
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
        for (const transform of contextTransforms) result = await transform(result);
        for (const fn of prepareRequestFns) result = await fn(result, signal);
        return await options.loopHooks?.prepareRequest?.(result, signal) ?? result;
      },
      pollFollowUp: async () => {
        const followUps = inbox.poll("followUp").map((item) => item.body);
        return await options.loopHooks?.pollFollowUp?.(signal) ?? followUps;
      },
      finishTurn: async (turn) => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        for (const fn of turnBoundaries) await fn(event, signal);
        const legacy = await options.loopHooks?.finishTurn?.(turn, signal);
        if (legacy !== undefined) return legacy;
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
        let stopReason: AssistantResult["stopReason"] = "stop";
        let terminal: { usage?: unknown; durationMs?: number; responseId?: string } = {};
        let failure: unknown;
        const snapshot = (): AgentMessage => ({
          role: "assistant",
          content,
          ...(thinking.length > 0 ? { thinking } : {}),
        });
        try {
          if (effectiveStreamFn !== undefined) {
            const base = (request ?? {}) as Partial<AgentStreamRequest>;
            const enriched: AgentStreamRequest = {
              ...base,
              messages: base.messages ?? [],
              tools: base.tools ?? providerToolSchemas(),
              ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              signal,
            } as AgentStreamRequest;
            for await (const chunk of effectiveStreamFn(enriched)) {
              if (signal.aborted) { stopReason = "aborted"; break; }
              if (typeof chunk === "string") {
                await emitConverted(chunk);
                content += chunk;
              } else if (chunk.type === "text") {
                content += chunk.text;
              } else if (chunk.type === "reasoning") {
                await emitConverted(chunk.text);
                thinking += chunk.text;
              } else if (chunk.type === "tool_call") {
                streamedCalls.push(chunk);
              } else if (chunk.type === "done") {
                stopReason = chunk.stopReason;
                terminal = {
                  ...(chunk.usage !== undefined ? { usage: chunk.usage } : {}),
                  ...(chunk.durationMs !== undefined ? { durationMs: chunk.durationMs } : {}),
                  ...(chunk.responseId !== undefined ? { responseId: chunk.responseId } : {}),
                };
                break;
              } else if (chunk.type === "error") {
                stopReason = "error";
                failure = chunk.error;
                terminal = {
                  ...(chunk.durationMs !== undefined ? { durationMs: chunk.durationMs } : {}),
                  ...(chunk.responseId !== undefined ? { responseId: chunk.responseId } : {}),
                };
                break;
              }
              if (onPartial !== undefined && (content.length > 0 || thinking.length > 0)) {
                partialSeq += 1;
                await onPartial(snapshot());
                updates.push({ type: "text_delta", delta: content, seq: partialSeq });
              }
            }
          }
        } catch (error) {
          stopReason = signal.aborted ? "aborted" : "error";
          failure = error;
        }
        if (signal.aborted) stopReason = "aborted";
        if (stopReason === "error") content = `Error: ${streamErrorMessage(failure)}`;

        const toolCalls: ToolCall[] = [];
        const records: AgentToolCallRecord[] = [];
        lastTurnHadNativeTools = streamedCalls.length > 0;
        if (stopReason !== "error" && stopReason !== "aborted") {
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
          stopReason,
          ...terminal,
          ...(failure !== undefined ? { error: failure } : {}),
          // 增量已在流式过程中通过 onPartial 发出，避免重复。
          updates: onPartial === undefined ? updates : [],
        };
      },

      toolPipeline: activePipeline,
    };

    const unsubscribeCompaction = compaction === undefined || compactionOptions === undefined
      ? undefined
      : stream.subscribe(createCompactionListener({
          budget: compactionOptions.budget,
          surface: compaction.surface,
          offloader: compaction.offloader,
          persist: persistCompaction,
          emit: emitCompaction,
          budgetTracker: compaction.budgetTracker,
          signal,
        }));
    try {
      await runLoop(runtime);
    } catch (error) {
      const message: AgentMessage = {
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
      await stream.emit({ type: "message_start", message }, signal);
      await stream.emit({ type: "message_end", message }, signal);
      await stream.emit({ type: "turn_end", message, toolResults: [] }, signal);
      await stream.emit({ type: "agent_end", messages: stream.getState().messages.slice(initialMessageCount) }, signal);
    } finally {
      unsubscribeCompaction?.();
    }
    return stream.getState().messages;
  }

  function toSnapshots<T>(registry: {
    snapshot(): readonly {
      readonly name: string;
      readonly value: T;
      readonly realm: symbol;
      readonly order: number;
      readonly replaceable: boolean;
      readonly required: boolean;
    }[];
  }, textOf?: (value: T) => string | undefined): ContributionSnapshot[] {
    return registry.snapshot().map((slot) => ({
      name: slot.name,
      text: textOf?.(slot.value),
      value: slot.value,
      order: slot.order,
      realm: slot.realm,
      replaceable: slot.replaceable,
      required: slot.required,
      generation: pluginGeneration,
    }));
  }

  return {
    prompt(text, signal) {
      if (typeof text !== "string") return Promise.reject(new Error("prompt: expected a string"));
      try {
        return startRun(text, signal);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    continue(signal) {
      try {
        return startRun(undefined, signal);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    steer: (message) => {
      inbox.steer(message);
    },
    followUp: (message) => {
      inbox.followUp(message);
    },
    // D11（延期）：框架 createCompactionListener 原语可用；facade 自动装配需要注入
    // surface/offloader 并补齐零回归测试，当前保持调用方自行订阅，按 O-03 延期。
    subscribe: (listener) => stream.subscribe(listener),
    sessionStore,
    compaction,
    abort() {
      aborted = true;
      activeRun?.controller.abort();
    },
    reset() {
      if (activeRun !== undefined) throw new Error("ACTIVE_RUN: reset 必须等待当前 run 结束");
      generation += 1;
      aborted = false;
      activeSignal = undefined;
      lastTurnHadNativeTools = false;
      inbox.clear("nextTurn");
      inbox.clear("nextStep");
      inbox.clear("followUp");
      stream.reset();
    },
    async waitForIdle() {
      while (activeRun !== undefined) await activeRun.promise.catch(() => {});
      await stream.waitForIdle();
    },
    ...api,
    api,
    tenantScope,
    emitEffect: (meta) => effectBridge.emit(meta),
    resolveLogSink: (options) => resolveLogSink(options),
    logger,
    async runTool(call) {
      // 裸回调入口也必须经过同一管线：权限、审批、egress、超时与 cleanup 共用一套实现。
      const check: BeforeToolCallHook = async (input) => {
        if (permissionGate !== undefined) {
          const decision = await permissionGate.authorize(permissionStage, input.tool, input.args);
          if (decision.behavior !== "ALLOW") {
            let approved = false;
            if (decision.behavior === "ASK") {
              approved = (
                await resolveApproval(permissionStage, input.tool, input.args, decision.reason, activeSignal)
              ).approved;
            }
            if (!approved) {
              return { block: true, reason: `PERMISSION_DENIED: ${decision.reason ?? "PERMISSION_DENIED"}` };
            }
          }
        }
        if (permissionPolicy !== undefined) {
          const verdict = evaluatePermissionPolicy(permissionPolicy, {
            stage: permissionStage,
            tool: input.tool,
            input: input.args,
          });
          if (verdict.behavior !== "ALLOW" && verdict.behavior !== "PASSTHROUGH") {
            return { block: true, reason: `TOOL_POLICY_${verdict.behavior}: ${verdict.reason ?? "denied"}` };
          }
        }
        if (checkEgress(input.args, egressPolicy).status === "denied") {
          return { block: true, reason: "EGRESS_DENIED" };
        }
        return {};
      };
      let invoked = false;
      const registry = createToolRegistry();
      registry.registerTool({
        name: call.name,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        execute: async () => {
          if (isCriticalLayerDegraded(securityBackend.capabilities())) {
            throw new Error("CRITICAL_LAYER_DEGRADED");
          }
          await securityBackend.run({ argv: [call.name] });
          invoked = true;
          return call.execute();
        },
      });
      try {
        const pipeline = createToolPipeline({
          registry,
          signal: activeSignal,
          beforeToolCall: check,
          timeoutMs: options.toolTimeoutMs,
        });
        const result = await pipeline.runToolCall({
          id: `runTool-${++runToolSeq}`,
          tool: call.name,
          input: {},
        });
        if (result.isError === true || !invoked) {
          return { ok: false, reason: String(result.reason ?? "TOOL_FAILED") };
        }
        return { ok: true, value: result.output };
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
    assemblyProfile,
    capabilityDiagnostics,
    get activeToolNames() {
      return activeToolNamesSnapshot();
    },
    pluginInstallations,
    pluginReviews,
    get pluginSections() {
      return toSnapshots(sectionRegistry, (value) => value.text);
    },
    get pluginWraps() {
      return toSnapshots(wrapRegistry);
    },
    get pluginTasks() {
      return toSnapshots(taskRegistry);
    },
    get pluginServices() {
      return toSnapshots(serviceRegistry);
    },
    get pluginGeneration() {
      return pluginGeneration;
    },
    resolveService(name, realm) {
      return serviceRegistry.resolve(name, realm);
    },
    async runTask(name, realm) {
      await taskRegistry.resolve(name, realm)?.();
    },
    providerToolSchemas,
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
      if (socketSink !== undefined) throw new Error("AUDIT_SOCKET_REQUIRES_ASYNC_FINALIZE");
      return localFinalization(revision);
    },
    async finalizeAuditAsync(revision) {
      if (socketSink === undefined) return localFinalization(revision);
      const state = socketSink.finalized(revision);
      const sealed = await socketSink.finalizeRemote(revision, state);
      const result = await socketSink.verifyRemote(revision);
      return {
        configured: true,
        finalized: result.finalized ?? state,
        entries: result.entries,
        verified: result.ok && sealed.ok,
      };
    },
    async closeAudit() {
      if (socketSink !== undefined) await socketSink.close();
    },
    createProviderStreamFn(config, fetchImpl) {
      return createProviderStreamFn(
        {
          ...config,
          ...(credentialVault !== undefined ? { credentialVault } : {}),
          ...(secretBroker !== undefined ? { secretBroker } : {}),
          ...(credentialBoundary !== undefined ? { credentialBoundary } : {}),
        },
        fetchImpl
      );
    },
  };
}
