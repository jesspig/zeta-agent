import { AsyncLocalStorage } from "node:async_hooks";
import {
  asNextTurnUpdate,
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
  type HookEntry,
  type HookSnapshot,
  type Inbox,
  type InboxMessage,
  type LoopDecision,
  type LoopRuntime,
  type LastTurn,
  type NextTurnUpdate,
  type PluginContribution,
  type PluginSlot,
  type PluginStatus,
  type QueueMode,
  type QueueTarget,
  type SourcePollPhase,
  type PluginMetadata,
  type ContributionContext,
  type ContributionExecutors,
  type InvocationGate,
  type IsolatedPlugin,
  type PluginTool,
  type PrepareNextTurn,
  type PrepareRequest,
  type QueueSource,
  type RedactRule,
  type StreamFn,
  type ToolCall,
  type ToolResult,
  type UsageSnapshot,
  aggregateUsage,
  createInitialState,
} from "@zeta-agent/agent-framework";
import {
  createToolLeaseManager,
  createToolPipeline,
  inputSchemaFromParameters,
  type BatchContext,
  type BeforeToolCallHook,
  type AfterToolCallHook,
  type PluginToolParameter,
  type ToolAuditEvent,
  type ToolDescriptor,
  type ToolPublisher,
  type ToolRegistry,
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
import { builtinToolDefinitions, type ToolDefinition, type ToolResourceLimits } from "./tools/builtins";
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
  confinedPath,
  createEgressPolicy,
  createOutboundClient,
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
  type OutboundClient,
  type SecretBroker,
  type StructuredExecutionBackend,
} from "@zeta-agent/security";
import { createProviderStreamFn } from "./providers/dispatch";
import {
  createProviderBroker,
  type ProviderBroker,
  type ProviderBrokerOptions,
  type ProviderRegistrationOptions,
} from "./providers/broker";
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
  readonly toolLimits?: ToolResourceLimits;
  readonly egressPolicy?: EgressPolicy;
  readonly egressTarget?: EgressTarget;
  readonly shellLimits?: AgentOptions["shellLimits"];
}): ToolDefinition[] {
  return [
    ...builtinToolDefinitions({
      securityBackend: options.securityBackend,
      allowedDirectories: options.allowedDirectories,
      ...(options.structuredBackend === undefined ? {} : { structuredBackend: options.structuredBackend }),
      ...(options.toolLimits === undefined ? {} : { limits: options.toolLimits }),
      ...(options.egressPolicy === undefined ? {} : { egress: options.egressPolicy }),
      ...(options.egressTarget === undefined ? {} : { egressTarget: options.egressTarget }),
      ...(options.shellLimits?.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.shellLimits.maxOutputBytes }),
      ...(options.shellLimits?.maxCpuMs === undefined ? {} : { maxCpuMs: options.shellLimits.maxCpuMs }),
      ...(options.shellLimits?.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: options.shellLimits.maxRuntimeMs }),
    }),
  ];
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
  /** 依赖环只把目标插件标为 FAILED，其他插件保持 ACTIVE。 */
  status: PluginStatus;
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

export type ToolFailure =
  | { readonly ok: false; readonly reason: string; readonly reconciliation?: boolean }
  | { readonly ok: true; readonly value: unknown };

export interface AgentToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: PluginToolParameter["type"];
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

/** 运行时识别隔离插件：品牌字段与隔离求值器一一对应，不能靠字符串猜测。 */
function isIsolatedPlugin(value: AgentPlugin): value is AgentPlugin & IsolatedPlugin {
  return (value as { isolated?: unknown }).isolated === true;
}

/**
 * 隔离插件 IPC 调用的宿主门禁：直接复用 T-11 出站策略/T-12 文件边界，
 * 不另起炉灶。任何携带网络目标或文件路径的参数都先过这两条既有边界。
 */
function createPluginInvocationGate(
  egressPolicy: EgressPolicy,
  allowedDirectories: readonly string[]
): InvocationGate {
  return {
    check(request) {
      const event: unknown = request.event;
      if (event === null || typeof event !== "object") return;
      const args = event as Readonly<Record<string, unknown>>;
      if (checkEgress(args, egressPolicy).status === "denied") throw new Error("EGRESS_DENIED");
      for (const key of ["path", "file", "filename", "cwd"] as const) {
        const value = args[key];
        if (typeof value !== "string" || value.length === 0) continue;
        try {
          confinedPath(value, allowedDirectories);
        } catch {
          throw new Error("FILE_CONFINEMENT_DENIED");
        }
      }
    },
  };
}

/** createProviderStreamFn 的 facade 投影；凭据由 Agent 注入，调用方无需重复传递。 */
export interface AgentProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly outbound?: OutboundClient;
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
  /** shell 命令的显式出站目标；未提供时结构化 shell 不声明网络目标（默认拒绝）。 */
  readonly egressTarget?: EgressTarget;
  /** read/grep/find 的字节、条目、深度与运行时间上限；超限显式截断或失败。 */
  readonly toolLimits?: ToolResourceLimits;
  /** shell 输出/CPU/时间上限；经 ShellRequest 透传给结构化后端。 */
  readonly shellLimits?: {
    readonly maxOutputBytes?: number;
    readonly maxCpuMs?: number;
    readonly maxRuntimeMs?: number;
  };
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
  /** 超时取消后等待工具确认终止的宽限期；未确认返回 unknown。 */
  readonly toolTimeoutConfirmationMs?: number;
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
  /** 可选会话存储：agent_end 的 newMessages 在 awaited listener 中逐条落盘后再 resolve prompt；创建时同步回放 committed transcript。 */
  readonly sessionStore?: SessionStore;
  /** 可选 broker；注入后所有模型请求统一经它路由，注册/切换不动 Agent 实例。 */
  readonly providerBroker?: ProviderBroker;
  /** broker 路由使用的 provider/model；可由 setProvider/setModel 热切换。 */
  readonly provider?: string;
  readonly model?: string;
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

/** HMR 安装的一个插件世代：持有自己的贡献 disposer，按在途 lease 精确撤销。 */
export interface HotPluginGeneration {
  readonly id: string;
  readonly generation: number;
  readonly plugin: AgentPlugin;
  readonly superseded: AgentPlugin | undefined;
  readonly status: "ACTIVE" | "RETIRING" | "DISPOSED";
  readonly inFlight: number;
  readonly disposeCount: number;
  /** 幂等；重复调用不增加 disposeCount。 */
  dispose(): void;
}

export interface Agent extends PluginApiSurface {
  prompt(text: string, signal?: AbortSignal): Promise<readonly AgentMessage[]>;
  continue(signal?: AbortSignal): Promise<readonly AgentMessage[]>;
  /** 运行中注入 steer 消息：下一轮轮首进入 transcript，无需等待新 prompt。 */
  steer(message: AgentMessage): void;
  /** 运行中注入 followUp 消息：按队列语义留到下一次轮首消费。 */
  followUp(message: AgentMessage): void;
  /** 注入 nextStep 消息：不唤醒当前 run，在 prepareNextTurn 时按 QueueMode claim。 */
  inject(message: AgentMessage): InboxMessage;
  /** 设置队列模式：all 全量消费、step 每次一条、interrupt 清空 nextStep 并插队 nextTurn。 */
  setQueueMode(mode: QueueMode): void;
  getQueueMode(): QueueMode;
  queueSize(target: QueueTarget): number;
  subscribe(listener: AgentListener): Disposer;
  abort(): void;
  /** 新建会话：清空会话上下文与在途状态，保留事件订阅。 */
  reset(): void;
  /** 取消在途工具并等待其 lease 结算；之后撤销插件贡献与审计连接。幂等。 */
  dispose(): Promise<void>;
  /** 只停止新准入（同步）；由装配层在关闭 watcher 前调用。 */
  closeAdmission(): void;
  readonly disposed: boolean;
  /** 与 waitForIdle 相同的 lease 视图：run + tool lease 计数。 */
  readonly activeLeaseCount: number;
  /** 安装或替换一个热重载插件世代；失败时旧世代保持 ACTIVE。 */
  hotSwapPlugin(id: string, plugin: AgentPlugin): HotPluginGeneration;
  /** 回滚到该世代被替换前的插件；用于 HMR 分区补偿。 */
  revertHotPlugin(generation: HotPluginGeneration): void;
  readonly hotPluginGenerations: readonly HotPluginGeneration[];
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
  /** 模型请求统一入口；生产装配中始终存在，register/switch 不重建 Agent。 */
  readonly providerBroker: ProviderBroker | undefined;
  registerProvider(id: string, streamFn: AgentStreamFn, options?: ProviderRegistrationOptions): Disposer;
  unregisterProvider(id: string): void;
  setProviderRoutes(routes: Readonly<Record<string, readonly string[]>>): void;
  setProviderFallback(providerIds: readonly string[]): void;
  setProvider(id: string | undefined): void;
  setModel(model: string | undefined): void;
  /** session/run 计费汇总，来自消息上的 done 终态而非 adapter 局部状态。 */
  readonly usageSummary: UsageSummary;
  lastRunUsage(): UsageSummary;
  /** 重新绑定 SessionStore 并从 committed transcript 回放；运行中拒绝。 */
  attachSessionStore(store: SessionStore): void;
  resumeSession(frameId: string): void;
  forkSession(fromId?: string): Promise<SessionStore>;
  truncateSession(frameId: string): Promise<SessionStore>;
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

function isLoopDecision(value: unknown): value is LoopDecision {
  if (typeof value !== "object" || value === null) return false;
  const action = (value as { readonly action?: unknown }).action;
  return action === "continue" || action === "end";
}

function turnFromEvent(event: AgentEvent): LastTurn {
  return event.type === "turn_end"
    ? { message: event.message, toolResults: event.toolResults }
    : { message: { role: "assistant", content: "" }, toolResults: [] };
}

function streamErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return error instanceof Error ? error.message : String(error);
}

/** session/run 计费汇总；只统计带 usage 的 assistant 终态，错误与重试不重复计入。 */
export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly responseId?: string;
  readonly requests: number;
  readonly errors: number;
}

function usageSummaryFrom(messages: readonly AgentMessage[]): UsageSummary {
  const billable = messages.filter((message) => message.role === "assistant" && message.usage !== undefined);
  const usage = aggregateUsage(messages) ?? {};
  const numeric = (key: "inputTokens" | "outputTokens" | "totalTokens" | "durationMs"): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    inputTokens: numeric("inputTokens"),
    outputTokens: numeric("outputTokens"),
    totalTokens: numeric("totalTokens"),
    durationMs: numeric("durationMs"),
    ...(typeof usage.responseId === "string" ? { responseId: usage.responseId } : {}),
    requests: billable.length,
    errors: messages.filter((message) =>
      message.role === "assistant" && typeof message.content === "string" && message.content.startsWith("Error:")
    ).length,
  };
}

const TOOLS_DECLARATION = /^tools:\s*(.*)$/m;

/**
 * committed transcript 回放：system 事实只用于计算，不回灌 state.messages；
 * 对话事实与工具声明分别恢复，避免重开时重复注入 system/tool 声明。
 */
function replayCommittedTranscript(messages: readonly AgentMessage[]): {
  readonly messages: readonly AgentMessage[];
  readonly systemPrompt: string;
  readonly declaredTools: readonly string[] | undefined;
} {
  const conversation: AgentMessage[] = [];
  let systemPrompt = "";
  let declaredTools: readonly string[] | undefined;
  for (const message of messages) {
    if (message.role === "system") {
      const fact = typeof message.content === "string" ? message.content : String(message.content ?? "");
      const declaration = fact.match(TOOLS_DECLARATION);
      if (declaration !== null) {
        declaredTools = (declaration[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
        const promptFact = fact.slice(0, declaration.index ?? 0).trim();
        if (promptFact.length > 0) systemPrompt = promptFact;
      } else if (fact.length > 0) {
        systemPrompt = fact;
      }
      continue;
    }
    conversation.push(message);
  }
  return { messages: conversation, systemPrompt, declaredTools };
}

/** 只读适配器：部分测试宿主提供仅含 append 的 SessionStore，投影缺失时按空 transcript 处理。 */
function projectionMessages(store: SessionStore | undefined): readonly AgentMessage[] {
  const projection = store?.projection?.();
  return Array.isArray(projection?.messages) ? projection!.messages : [];
}

export function createAgent(options: AgentOptions = {}): Agent {
  const tenantScope = options.tenantScope;
  let activeSessionStore: SessionStore | undefined = tenantScope?.sessionStore ?? options.sessionStore;
  const restoredTranscript = activeSessionStore === undefined
    ? { messages: [] as readonly AgentMessage[], systemPrompt: "", declaredTools: undefined as readonly string[] | undefined }
    : replayCommittedTranscript(projectionMessages(activeSessionStore));
  const restoredUsage = aggregateUsage(restoredTranscript.messages);
  const stream = createEventStream(createInitialState({
    messages: restoredTranscript.messages,
    systemPrompt: restoredTranscript.systemPrompt,
    ...(restoredUsage === undefined ? {} : { usage: restoredUsage }),
    ...(typeof restoredUsage?.durationMs === "number" ? { durationMs: restoredUsage.durationMs } : {}),
    ...(typeof restoredUsage?.responseId === "string" ? { responseId: restoredUsage.responseId } : {}),
  }));
  // 单一 writer：agent_end 只含本次 newMessages；重绑定 store 时无需重建订阅者。
  stream.subscribe(async (event) => {
    if (event.type !== "agent_end") return;
    const store = activeSessionStore;
    if (store === undefined) return;
    for (const item of event.messages) await store.append(item);
  });
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
  let auditClosed = false;
  /** 审计连接由 agent 独占：所有输出排空后才关闭，且只关一次。 */
  async function closeAuditSink(): Promise<void> {
    if (auditClosed) return;
    auditClosed = true;
    if (socketSink !== undefined) await socketSink.close();
    const injected = auditSink as ({ close?: () => void | Promise<void> } | undefined);
    if (injected !== undefined && typeof injected.close === "function" && injected !== socketSink) {
      await injected.close();
    }
  }
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
    const store = activeSessionStore;
    if (store === undefined) return;
    for (const lineage of lineages.slice(persistedLineageCount)) {
      await store.appendRecap(lineage.recap, lineage.uris, {
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
    ? builtinTools({
        securityBackend,
        allowedDirectories,
        structuredBackend,
        toolLimits: options.toolLimits,
        // 默认拒绝的出站策略也必须随 ShellRequest 下发，避免 shell 绕开数据面。
        egressPolicy: options.egressPolicy ?? createEgressPolicy(),
        egressTarget: options.egressTarget,
        shellLimits: options.shellLimits,
      })
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
    // section 贡献是真实提示词的一部分，按注册入口的 order 排序后追加；在途 run 用捕获的旧快照。
    const scopeSections = dispatchScope.getStore()?.sections;
    const sections = scopeSections ?? sectionRegistry.snapshot().map((slot) => slot.value.text);
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
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let generation = 0;
  interface RunLease {
    readonly generation: number;
    readonly controller: AbortController;
    promise: Promise<readonly AgentMessage[]>;
  }
  let activeRun: RunLease | undefined;
  /** 当前回合是否使用了 provider 原生 tool_calls（决定是否自动续跑消费工具结果）。 */
  let lastTurnHadNativeTools = false;
  let lastRunMessages: readonly AgentMessage[] = [];

  // 插件 API 的工具/身份集合仍用 map 做快照；hook 的真实生产路径统一由 pluginManager 负载。
  interface PluginToolEntry {
    readonly tool: PluginTool;
    readonly token: object;
    readonly meta: ContributionContext;
    readonly dispose: () => void;
  }
  interface AfterHookAccumulator {
    readonly event: AgentEvent;
    readonly overrides: Record<string, unknown>;
  }
  const pluginTools = new Map<string, PluginToolEntry>();
  const declaredLoadout = new Map<string, PluginTool>();
  // 插件生命周期（有序注册 / 幂等 disposer / LIFO 撤销）由 agent-framework 的核心管线提供。
  const pluginManager = options.pluginManager ?? new AgentPluginManager();
  const events = createEventBus();

  // ── 调用快照（dispatch scope）─────────────────────────────────────────────
  // 在途 run/tool 在开始时捕获 hook 条目、工具 descriptor、section/task/service 与插件世代；
  // HMR 替换只影响之后的新调用，旧世代的 disposer 在在途 lease 归零后才执行。
  interface FrozenService {
    readonly name: string;
    readonly realm: symbol;
    readonly value: unknown;
  }
  interface DispatchScope {
    readonly hooks: HookSnapshot;
    readonly tools: ReadonlyMap<string, ToolDescriptor>;
    readonly sections: readonly string[];
    readonly tasks: readonly { readonly name: string; readonly handler: (() => void | Promise<void>) | undefined }[];
    readonly services: readonly FrozenService[];
    readonly generations: readonly HotGenerationState[];
  }
  interface HotGenerationState {
    readonly id: string;
    readonly generation: number;
    readonly plugin: AgentPlugin;
    readonly superseded: AgentPlugin | undefined;
    status: HotPluginGeneration["status"];
    inFlight: number;
    disposeCount: number;
    readonly disposers: Disposer[];
    readonly installations: PluginInstallation[];
    /** 本世代贡献的工具名：在途调用据此持有旧 descriptor。 */
    readonly toolNames: readonly string[];
    /** 本世代贡献的 service 槽位（name + realm）：在途调用据此解析旧值。 */
    readonly serviceSlots: readonly { readonly name: string; readonly realm: symbol }[];
    handle: HotPluginGeneration;
  }
  type FacadeHookOptions = { readonly failClosed?: boolean; readonly reverse?: boolean };
  const dispatchScope = new AsyncLocalStorage<DispatchScope>();
  const hotGenerations = new Map<string, HotGenerationState>();
  const scopedHooks = (): HookSnapshot => dispatchScope.getStore()?.hooks ?? pluginManager.snapshot();
  const hookRun = <I>(
    chain: string,
    input: I,
    signal?: AbortSignal,
    options?: FacadeHookOptions
  ): Promise<I> => pluginManager.run(chain, input, signal, {
    ...(options ?? {}),
    snapshot: scopedHooks(),
  });
  const hookRunEach = <I>(
    chain: string,
    input: I,
    signal: AbortSignal | undefined,
    visit: (value: unknown, entry: HookEntry<I>) => void | Promise<void>
  ): Promise<void> => pluginManager.runEach(chain, input, signal, visit, { snapshot: scopedHooks() });

  function disposeGeneration(state: HotGenerationState): void {
    if (state.status === "DISPOSED") return;
    state.status = "DISPOSED";
    state.disposeCount += 1;
    for (const stop of [...state.disposers].reverse()) stop();
    for (const installation of state.installations) {
      const index = pluginInstallations.indexOf(installation);
      if (index >= 0) pluginInstallations.splice(index, 1);
      installationContributionDisposers.delete(installation);
      const tracked = pluginTracking.get(installation.plugin);
      if (tracked !== undefined) {
        tracked();
        pluginTracking.delete(installation.plugin);
      }
    }
    if (hotGenerations.get(state.id) === state) hotGenerations.delete(state.id);
  }
  function retireIfIdle(state: HotGenerationState): void {
    if (state.status === "RETIRING" && state.inFlight === 0) disposeGeneration(state);
  }
  function captureScope(): DispatchScope {
    const generations = [...hotGenerations.values()].filter((state) => state.status === "ACTIVE");
    for (const state of generations) state.inFlight += 1;
    // 只冻结热插件工具：宿主在 run 中直接注册的工具仍按原语义即时可见。
    const tools = new Map<string, ToolDescriptor>();
    for (const state of generations) {
      for (const name of state.toolNames) {
        const entry = pluginTools.get(name);
        if (entry !== undefined) tools.set(name, descriptorFor(entry.tool));
      }
    }
    // service 与工具同源冻结：只冻结热插件贡献的槽位，宿主/非热服务仍按实时注册表解析。
    const services: FrozenService[] = [];
    for (const state of generations) {
      for (const slot of state.serviceSlots) {
        services.push({
          name: slot.name,
          realm: slot.realm,
          value: serviceRegistry.resolve(slot.name, slot.realm),
        });
      }
    }
    const scope: DispatchScope = {
      hooks: pluginManager.snapshot(),
      tools,
      sections: sectionRegistry.snapshot().map((slot) => slot.value.text),
      tasks: taskRegistry.snapshot().map((slot) => ({ name: slot.name, handler: slot.value })),
      services,
      generations,
    };
    return scope;
  }
  function releaseScope(scope: DispatchScope): void {
    for (const state of scope.generations) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      retireIfIdle(state);
    }
  }
  /** 在当前 scope 中运行；无论正常/异常都按同一 lease 视图释放世代引用。 */
  async function withScope<T>(fn: () => Promise<T>): Promise<T> {
    const scope = captureScope();
    try {
      return await dispatchScope.run(scope, fn);
    } finally {
      releaseScope(scope);
    }
  }

  /** 持久 inbox：外部可在运行中 steer()/followUp()，由下一轮轮首统一 poll。 */
  const inbox: Inbox = createInbox();
  let hookSequence = 0;
  const nextHookName = (chain: string): string => `${chain}#${++hookSequence}`;
  function registerHook<I>(
    chain: string,
    fn: (input: I, signal?: AbortSignal) => unknown | Promise<unknown>,
    name?: string
  ): Disposer {
    return pluginManager.addHook<I>(chain, fn, undefined, name ?? nextHookName(chain));
  }

  // legacy 字段赋值转换为 `legacy:<field>` 条目，参与同一链（最低优先级），不再旁路执行。
  const legacyHooks = options.loopHooks;
  if (legacyHooks?.prepareRequest !== undefined) {
    pluginManager.setLegacy("prepareRequest", (input) =>
      legacyHooks.prepareRequest!(input, activeSignal) ?? input);
  }
  if (legacyHooks?.prepareNextTurn !== undefined) {
    pluginManager.setLegacy("prepareNextTurn", (input) =>
      legacyHooks.prepareNextTurn!(input, activeSignal));
  }
  if (legacyHooks?.finishTurn !== undefined) {
    pluginManager.setLegacy("turnBoundary", (input) =>
      legacyHooks.finishTurn!(turnFromEvent(input as AgentEvent), activeSignal));
  }
  if (legacyHooks?.pollFollowUp !== undefined) {
    pluginManager.setLegacy("pollFollowUp", async () =>
      (await legacyHooks.pollFollowUp!(activeSignal)) ?? undefined);
  }

  async function pollQueueSources(signal: AbortSignal, kinds: "all" | "steering" = "all"): Promise<void> {
    await hookRun("steering", inbox, signal);
    // prepareNextTurn 只重轮询 steering：followUp 在这里重入会与 natural end 外层消费互相喂料而无限续跑。
    if (kinds === "all") await hookRun("followUp", inbox, signal);
  }

  function addDisposer(dispose: () => void): () => void {
    return pluginManager.addDisposer(dispose);
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
  const pluginTracking = new Map<AgentPlugin, Disposer>();
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
    wrap: (item, ctx) => {
      // registry 仅承载公开快照；真实执行经 manager 的 wrap 链（含拓扑排序/环隔离）。
      const stopRegistry = wrapRegistry.register({
        name: item.name,
        value: item.handler ?? (() => undefined),
        realm: ctx.realm,
        order: ctx.order,
        replaceable: ctx.replaceable,
        required: ctx.required,
        source: ctx.source,
      });
      const ownerPrefix = ctx.owner === undefined ? "" : `${ctx.owner}:`;
      const stopHook = pluginManager.addHook<AgentEvent>(
        "wrap",
        (event, signal) => item.handler?.(event, signal),
        ctx.priority ?? ctx.order,
        `${ownerPrefix}${item.name}`,
        { dependsOn: ctx.dependsOn }
      );
      return () => {
        stopHook();
        stopRegistry();
      };
    },
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
    // T-13：隔离插件的可执行项只能经 IPC 调用；把 T-11/T-12 边界注入到调用门禁。
    if (isIsolatedPlugin(plugin)) {
      plugin.setInvocationGate(createPluginInvocationGate(egressPolicy, allowedDirectories));
    }
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
      // T-13 信任收口：宿主只对可信插件调用 install()；不可信插件的 install 永不进入宿主。
      const dispose = entry.trusted ? entry.item.install() : (): void => undefined;
      // 保留 install() 原样 disposer；管理器只登记状态/顺序，不重复调用 install。
      pluginTracking.set(entry.item, addDisposer(pluginManager.trackInstall(entry.item)));
      return dispose;
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
        status: "ACTIVE",
      };
      pluginInstallations.push(installation);
      const contributionDisposers: Disposer[] = [];
      installationContributionDisposers.set(installation, contributionDisposers);
      addDisposer(record.dispose);
      for (const item of entry.item.contributions) {
        // T-13 信任收口：宿主只对可信插件注册可执行项；不可信插件只保留数据型 section。
        // hook 曾在宿主链上执行不可信函数，这条路径必须关闭；不可信工具/服务/wrap/task 同理。
        if (!entry.trusted && item.kind !== "section") continue;
        const stop = contributionHost.apply(item, {
          realm: item.realm ?? entry.realm ?? defaultRealm,
          order: item.order ?? entry.order,
          priority: item.priority ?? entry.item.priority,
          dependsOn: item.dependsOn ?? entry.item.dependsOn,
          owner: entry.item.name,
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
      // 环只让目标插件 FAILED；其他插件的 hook 继续留在同一链上执行。
      installation.status = pluginManager.syncPluginStatus(entry.item).status;
    },
    unapply: (entry, record) => {
      const index = pluginInstallations.findIndex((item) => item.dispose === record.dispose);
      const installation = index >= 0 ? pluginInstallations[index] : undefined;
      if (installation === undefined) return;
      for (const stop of installationContributionDisposers.get(installation) ?? []) stop();
      installationContributionDisposers.delete(installation);
      pluginTracking.get(entry.item)?.();
      pluginTracking.delete(entry.item);
      pluginInstallations.splice(index, 1);
    },
  });
  if (installResult.error !== undefined) throw installResult.error;
  // 最后一批贡献也可能补全依赖图：统一重算所有插件状态，环只影响目标插件。
  for (const installation of pluginInstallations) {
    installation.status = pluginManager.syncPluginStatus(installation.plugin).status;
  }

  // 有 streamFn 时 facade 自身也装配 broker，保证模型请求始终只有一条路由路径。
  const providerBroker = options.providerBroker ?? (baseStreamFn !== undefined ? createProviderBroker() : undefined);
  let providerId: string | undefined = options.provider;
  let modelRef: string | undefined = options.model;
  const BASE_PROVIDER = "base";
  const PLUGIN_PROVIDER = "plugin";
  const brokerRegistrations: Disposer[] = [];
  let pluginProviderFn: ((request: AgentStreamRequest, signal?: AbortSignal) => unknown) | undefined;
  let pluginProviderRegistration: Disposer | undefined;
  if (providerBroker !== undefined && baseStreamFn !== undefined) {
    brokerRegistrations.push(providerBroker.register(BASE_PROVIDER, baseStreamFn, { terminalPolicy: "passthrough" }));
  }

  function activeStreamFn(): AgentStreamFn | undefined {
    // 单一管理器链的最后（最高优先级/最新注册）provider 生效。
    const pluginFn = pluginManager.chain<AgentStreamRequest>("streamFn").snapshot().at(-1)?.fn as
      | ((request: AgentStreamRequest, signal?: AbortSignal) => unknown)
      | undefined;
    const asStreamFn: AgentStreamFn | undefined = pluginFn === undefined
      ? undefined
      : (request) => pluginFn(request, request.signal) as AsyncIterable<AgentStreamChunk>;
    if (pluginFn !== pluginProviderFn) {
      pluginProviderRegistration?.();
      pluginProviderRegistration = undefined;
      pluginProviderFn = pluginFn;
      if (asStreamFn !== undefined && providerBroker !== undefined) {
        pluginProviderRegistration = providerBroker.register(PLUGIN_PROVIDER, asStreamFn, { terminalPolicy: "passthrough" });
      }
    }
    if (providerBroker === undefined) return asStreamFn ?? baseStreamFn;
    return (request) => providerBroker.stream({
      ...request,
      ...(request.provider === undefined && request.model === undefined
        ? { provider: asStreamFn !== undefined ? PLUGIN_PROVIDER : BASE_PROVIDER }
        : {}),
    });
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

  /** 上一次声明的工具名优先取 committed transcript；没有声明时以真实 registry 为基线。 */
  let declaredToolNames: readonly string[] = restoredTranscript.declaredTools ?? [...toolNamesSnapshot()];

  /** 会话切换只替换 transcript 基线与写入目标，不重建 Agent/插件/provider 注册。 */
  function rebindSessionStore(store: SessionStore): void {
    if (activeRun !== undefined) throw new Error("ACTIVE_RUN: 会话切换必须等待当前 run 结束");
    const projection = store.projection();
    const replayed = replayCommittedTranscript(projection.messages);
    const restoredUsage = aggregateUsage(replayed.messages);
    stream.reset(createInitialState({
      messages: replayed.messages,
      systemPrompt: replayed.systemPrompt,
      ...(restoredUsage === undefined ? {} : { usage: restoredUsage }),
      ...(typeof restoredUsage?.durationMs === "number" ? { durationMs: restoredUsage.durationMs } : {}),
      ...(typeof restoredUsage?.responseId === "string" ? { responseId: restoredUsage.responseId } : {}),
    }));
    activeSessionStore = store;
    declaredToolNames = replayed.declaredTools ?? [...toolNamesSnapshot()];
    persistedLineageCount = projection.lineage.length;
    lastRunMessages = [];
    lastTurnHadNativeTools = false;
    inbox.clear("nextTurn");
    inbox.clear("nextStep");
    inbox.clear("followUp");
  }

  // ── 统一工具域：模型工具与 runTool 共用 registry/hooks/审计/effects/leases ──
  const toolLeases = createToolLeaseManager();
  /** 发射工具 callId → durable key，commit 后由 publisher 回填真实结果。 */
  let emissionSlots = new Map<string, string>();
  let commitPromise: Promise<readonly Receipt[]> | undefined;
  let committed: Map<string, Receipt> | undefined;

  function auditTool(event: ToolAuditEvent): void {
    const decision = event.reason.includes("TOOL_INPUT_")
      ? "TOOL_INPUT_REJECTED"
      : event.reason === "TOOL_TIMEOUT_UNKNOWN"
        ? "TOOL_OUTCOME_UNKNOWN"
        : event.reason.startsWith("TOOL_TIMEOUT")
          ? "TOOL_TIMEOUT"
          : "TOOL_REJECTED";
    recordAudit(event.tool, stableHash(JSON.stringify(event.args)), decision, event.reason, event.call.id);
  }

  /** 工具声明（builtin/plugin/loadout/MCP）投影为真实执行 schema。 */
  function descriptorFor(
    tool: PluginTool,
    options: { readonly verify?: (signal?: AbortSignal) => void | Promise<void> } = {}
  ): ToolDescriptor {
    return {
      name: tool.name,
      inputSchema: inputSchemaFromParameters(tool.parameters),
      execute: async (args, exec) => {
        if (exec.signal?.aborted === true) throw new Error("ABORTED");
        if (options.verify !== undefined) await options.verify(exec.signal);
        const digest = stableHash(JSON.stringify(args));
        exec.onUpdate(`executing ${tool.name}`);
        if (isEmissionTool(tool.name) && durableEffects !== undefined && !dispatchingEmission) {
          const key = `${tool.name}:${digest}`;
          const quota = tenantScope?.quota;
          if (quota !== undefined) {
            const request = { tool: tool.name, tokens: 1 };
            if (!quota.check(request) || !quota.reserve(request)) {
              recordAudit(tool.name, digest, "QUOTA_DENIED", "QUOTA_EXHAUSTED", key);
              throw new Error("QUOTA_EXHAUSTED");
            }
          }
          const verdict = checkEgress(args, egressPolicy);
          durableEffects.enqueue(tool.name, key, {
            tool: tool.name,
            args,
            ...(verdict.status === "allowed" ? { target: verdict.target } : {}),
          });
          recordAudit(tool.name, digest, "EMISSION_WITHHELD", key, "pending");
          return { ok: true, withheld: true, tool: tool.name, key };
        }
        return (tool.execute as (input: never, signal?: AbortSignal) => unknown)(args as never, exec.signal);
      },
    };
  }

  const runToolDescriptors = new Map<string, ToolDescriptor>();
  const pipelineRegistry: ToolRegistry = {
    registerTool(tool) {
      if (runToolDescriptors.has(tool.name)) throw new Error("TOOL_DUPLICATE");
      runToolDescriptors.set(tool.name, tool);
      return () => {
        runToolDescriptors.delete(tool.name);
      };
    },
    getTool(name) {
      const transient = runToolDescriptors.get(name);
      if (transient !== undefined) return transient;
      const scoped = dispatchScope.getStore()?.tools.get(name);
      if (scoped !== undefined) return scoped;
      const loadout = declaredLoadout.get(name);
      if (loadout !== undefined) return descriptorFor(loadout);
      const plugin = pluginTools.get(name);
      if (plugin !== undefined) return descriptorFor(plugin.tool);
      const builtin = toolDefinitions.find((item) => item.name === name);
      return builtin === undefined ? undefined : descriptorFor(builtin);
    },
    get size() {
      const names = new Set([
        ...runToolDescriptors.keys(),
        ...declaredLoadout.keys(),
        ...pluginTools.keys(),
        ...toolDefinitions.map((item) => item.name),
      ]);
      return names.size;
    },
  };

  const publisher: ToolPublisher = async (result) => {
    // commit 派发阶段再次进入管线时不得等待自己尚未完成的 commit。
    if (dispatchingEmission || emissionSlots.size === 0 || durableEffects === undefined) return result;
    if (committed === undefined) {
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
    const startEvent: AgentEvent = {
      type: "tool_execution_start", toolCallId: input.call.id, toolName: name, args,
    };
    await hookRun("beforeToolCall", startEvent, toolSignal ?? activeSignal, { failClosed: true });
    await hookRun("wrap", startEvent, toolSignal ?? activeSignal, { failClosed: true });
    return {};
  };

  const after: AfterToolCallHook = async (input, toolSignal) => {
    const name = input.call.tool ?? input.call.name ?? "";
    const overrides: Record<string, unknown> = {};
    const capture = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      for (const key of ["content", "details", "structuredContent", "usage"] as const) {
        if (key in record) overrides[key] = record[key];
      }
      if (typeof record.isError === "boolean") overrides.isError = record.isError;
      if (typeof record.terminate === "boolean") overrides.terminate = record.terminate;
    };
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
    const endEvent: AgentEvent = {
      type: "tool_execution_end" as const,
      toolCallId: input.call.id,
      toolName: name,
      result: input.output,
      isError: input.isError,
    };
    const accumulator: AfterHookAccumulator = { event: endEvent, overrides };
    await hookRun("afterToolCall", accumulator, toolSignal ?? activeSignal, { failClosed: true });
    capture(accumulator.overrides);
    await hookRun("wrap", endEvent, toolSignal ?? activeSignal, { failClosed: true, reverse: true });
    return overrides;
  };

  const toolContext: BatchContext = {
    registry: pipelineRegistry,
    audit: auditTool,
    toolLeases,
    beforeToolCall: before,
    afterToolCall: after,
    publisher,
    timeoutMs: options.toolTimeoutMs,
    timeoutConfirmationMs: options.toolTimeoutConfirmationMs,
    get signal() {
      return activeSignal;
    },
  };
  const activePipeline = createToolPipeline(toolContext);

  const api: PluginApiSurface = {
    registerTool(tool) {
      return registerToolEntry(tool);
    },
    onEvent(handler) {
      return addDisposer(stream.subscribe(handler));
    },
    addConverter(fn) {
      return registerHook<unknown>("converter", (input) => fn(input));
    },
    addContextTransform(fn) {
      return registerHook<unknown>("contextTransform", (input) => fn(input));
    },
    addBeforeToolCall(fn) {
      return registerHook<AgentEvent>("beforeToolCall", (event, signal) => fn(event, signal));
    },
    addAfterToolCall(fn) {
      return registerHook<AfterHookAccumulator>("afterToolCall", async (input, signal) => {
        const override = await fn(input.event, signal);
        if (typeof override === "object" && override !== null) Object.assign(input.overrides, override);
      });
    },
    addTurnBoundary(fn) {
      return registerHook<AgentEvent>("turnBoundary", (event, signal) => fn(event, signal));
    },
    addPrepareRequest(fn) {
      return registerHook<unknown>("prepareRequest", (input, signal) => fn(input, signal));
    },
    addPrepareNextTurn(fn) {
      return registerHook<unknown>("prepareNextTurn", (input, signal) => fn(input, signal));
    },
    provideSteering(source) {
      return registerHook<Inbox>("steering", async (inbox) => {
        const message = await source.next() as AgentMessage | undefined;
        if (message !== undefined) inbox.steer(message);
      }, `steering:${source.name ?? nextHookName("steering")}`);
    },
    provideFollowUp(source) {
      return registerHook<Inbox>("followUp", async (inbox) => {
        const message = await source.next() as AgentMessage | undefined;
        if (message !== undefined) inbox.followUp(message);
      }, `followUp:${source.name ?? nextHookName("followUp")}`);
    },
    provideStreamFn(fn) {
      return registerHook<unknown>("streamFn", (input) => fn(input));
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
      pluginTracking.clear();
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
  const TURN_CONTINUE_DECISION = { action: "continue" } as const;
  const TURN_END_DECISION = { action: "end" } as const;
  // 工具结果仅回传本地执行信息，不重新进入模型（避免 stub 下的无限续跑）。
  const NO_TOOL_RESULT = "";

  /** 从真实工具声明投影 provider schema：builtin、插件、loadout 与 MCP 共用同一来源。 */
  function toToolSchema(tool: PluginTool): AgentToolSchema {
    return {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: (tool.parameters ?? []).map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        description: parameter.description ?? parameter.name,
        ...(parameter.required === true ? { required: true } : {}),
      })),
    };
  }

  /** provider schema 从最终 active registry 生成，未支持工具不进入模型可见面。 */
  function providerToolSchemas(): AgentToolSchema[] {
    const active = new Set(activeToolNamesSnapshot());
    const schemas = new Map<string, AgentToolSchema>();
    const add = (tool: PluginTool): void => {
      if (active.has(tool.name)) schemas.set(tool.name, toToolSchema(tool));
    };
    for (const tool of toolDefinitions) add(tool);
    for (const entry of pluginTools.values()) add(entry.tool);
    for (const tool of declaredLoadout.values()) add(tool);
    return [...schemas.values()];
  }

  /** 把已拼接的文本投影为 message_update 所需的流式部分快照。 */
  function textSnapshot(content: string): AssistantMessageEvent {
    return { type: "text_delta", delta: content };
  }

  function startRun(userText: string | undefined, externalSignal?: AbortSignal): Promise<readonly AgentMessage[]> {
    if (disposed) throw new Error("AGENT_DISPOSED: dispose 后不再接受新 run");
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
    const execution = withScope(() => executeRun(lease, userText)).finally(() => {
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
    const tasks = dispatchScope.getStore()?.tasks
      ?? taskRegistry.snapshot().map((slot) => ({ name: slot.name, handler: slot.value }));
    for (const task of tasks) {
      try {
        await task.handler?.();
      } catch (error) {
        fiberLogger.warn(`plugin task ${task.name} failed: ${String(error)}`);
      }
    }

    if (userText !== undefined) inbox.steer({ role: "user", content: userText });
    await pollQueueSources(signal);
    // followUp 不在这里 promote：自然终局由 runLoop 外层 pollFollowUp 消费；
    // 硬终局保留的队列在下一个 run 的自然终局外层消费，不会永久滞留。

    // 工具域在 agent 作用域只建一次；每回合仅重置发射槽与 durable commit 快照。
    emissionSlots = new Map<string, string>();
    commitPromise = undefined;
    committed = undefined;

    const effectiveStreamFn = activeStreamFn();
    const emitConverted = async (input: unknown): Promise<void> => {
      await hookRunEach("converter", input, signal, async (value) => {
        if (value !== undefined) await stream.emit(value as AgentEvent, signal);
      });
    };

    const runtime: LoopRuntime = {
      inbox,
      signal,
      turnBudget: options.turnBudget,
      emit: (event) => stream.emit(event, signal),
      getState: () => stream.getState(),
      prepareNextTurn: async (): Promise<NextTurnUpdate | undefined> =>
        asNextTurnUpdate(await hookRun("prepareNextTurn", stream.getState(), signal)),
      pollSources: async (phase: SourcePollPhase): Promise<void> => {
        await pollQueueSources(signal, phase === "prepareNextTurn" ? "steering" : "all");
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
        // 工具声明 system 消息可能排在 transcript 首位；按内容判重，保证提示词恰好注入一次。
        const alreadyInjected = base.messages?.some((message) => message.role === "system" && message.content === prompt) === true;
        const seeded = {
          ...(request as object),
          messages:
            prompt.length > 0 && !alreadyInjected
              ? [{ role: "system" as const, content: prompt }, ...(base.messages ?? [])]
              : (base.messages ?? []),
        };
        const transformed = await hookRun("contextTransform", seeded, signal);
        return await hookRun("prepareRequest", transformed, signal);
      },
      pollFollowUp: async () => {
        const followUps = inbox.poll("followUp").map((item) => item.body);
        return await hookRun("pollFollowUp", followUps, signal);
      },
      finishTurn: async (turn) => {
        const event: AgentEvent = { type: "turn_end", message: turn.message, toolResults: turn.toolResults };
        const outcome = await hookRun("turnBoundary", event, signal);
        if (isLoopDecision(outcome)) return outcome;
        // 原生工具调用需要显式续跑一轮，让模型消费工具结果。
        if (lastTurnHadNativeTools && turn.toolResults.length > 0) return TURN_CONTINUE_DECISION;
        // 文本标记协议保持单轮收束：结果已落盘，不能把 toolCalls 交给默认续跑反复解析。
        if (turn.toolResults.length > 0) return TURN_END_DECISION;
        // 无显式决策时交还 runLoop 走 natural end，由外层消费 follow-up / explicitContinuation。
        return undefined;
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
        let terminal: { usage?: UsageSnapshot; durationMs?: number; responseId?: string } = {};
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
              ...(providerId !== undefined ? { provider: providerId } : {}),
              ...(modelRef !== undefined ? { model: modelRef } : {}),
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
                  ...(typeof chunk.usage === "object" && chunk.usage !== null ? { usage: chunk.usage as UsageSnapshot } : {}),
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
            ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
            ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
            ...(terminal.responseId !== undefined ? { responseId: terminal.responseId } : {}),
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
    const allMessages = stream.getState().messages;
    lastRunMessages = allMessages.slice(initialMessageCount);
    return allMessages;
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

  /** 与 waitForIdle 共用的 lease 视图：先等 run，再等 tool lease，最后等 listener。 */
  async function drainLeases(): Promise<void> {
    while (activeRun !== undefined) await activeRun.promise.catch(() => {});
    await toolLeases.waitForIdle();
    await stream.waitForIdle();
  }

  const serviceSlotsOf = (candidate: AgentPlugin): readonly { readonly name: string; readonly realm: symbol }[] =>
    candidate.contributions.flatMap((item) =>
      item.kind === "service" ? [{ name: item.name, realm: item.realm ?? defaultRealm }] : []
    );

  /** 热重载插件的独立安装事务：新世代先完整安装成功，才替换旧世代。 */
  function hotSwapPlugin(id: string, plugin: AgentPlugin): HotPluginGeneration {
    if (disposed) throw new Error("AGENT_DISPOSED");
    if (typeof id !== "string" || id.length === 0) throw new Error("HOT_PLUGIN_ID_REQUIRED");
    const previous = hotGenerations.get(id);
    // 替换前保留旧 service 槽：事务中途失败时连带恢复，避免同名注册覆盖后留下空洞。
    const oldServiceSlots = previous === undefined ? [] : serviceRegistry.snapshot().filter((slot) =>
      previous.serviceSlots.some((owned) => owned.name === slot.name && owned.realm === slot.realm)
    );
    const hotGeneration = ++pluginGeneration;
    const tx = createPluginTransaction<AgentPlugin>({ generation: () => hotGeneration });
    // 热重载来源是宿主本地文件，与初始宿主插件一致按可信处理；贡献仍走同一审查/注册入口。
    tx.stage([{ item: plugin, meta: { name: plugin.name, trusted: true } }]);
    const issues = tx.validate();
    if (issues.length > 0) throw new Error(`PLUGIN_VALIDATION_FAILED: ${issues.map((issue) => issue.reason).join(",")}`);
    const contributionStops: Disposer[] = [];
    const installations: PluginInstallation[] = [];
    const result = tx.commit({
      install: (entry) => {
        const dispose = entry.item.install();
        pluginTracking.set(entry.item, addDisposer(pluginManager.trackInstall(entry.item)));
        return dispose;
      },
      apply: (entry, record) => {
        const installation: PluginInstallation = {
          plugin: entry.item,
          generation: hotGeneration,
          dispose: record.dispose,
          realm: defaultRealm,
          review: {
            decision: "allowed",
            reason: "HOT_RELOAD",
            source: { origin: "user", trusted: true },
          },
          status: "ACTIVE",
        };
        pluginInstallations.push(installation);
        installations.push(installation);
        const contributionDisposers: Disposer[] = [];
        installationContributionDisposers.set(installation, contributionDisposers);
        for (const item of entry.item.contributions) {
          if (!entry.trusted && item.kind !== "section" && item.kind !== "hook") continue;
          const stop = contributionHost.apply(item, {
            realm: item.realm ?? defaultRealm,
            order: item.order ?? entry.order,
            priority: item.priority ?? entry.item.priority,
            dependsOn: item.dependsOn ?? entry.item.dependsOn,
            owner: entry.item.name,
            replaceable: item.replaceable ?? entry.replaceable,
            required: item.required ?? entry.required,
            source: item.source ?? entry.source,
            trusted: item.trusted ?? entry.trusted,
            generation: hotGeneration,
          });
          contributionDisposers.push(stop);
          contributionStops.push(stop);
        }
        installation.status = pluginManager.syncPluginStatus(entry.item).status;
      },
      unapply: (entry, record) => {
        const index = pluginInstallations.findIndex((item) => item.dispose === record.dispose);
        if (index >= 0) pluginInstallations.splice(index, 1);
        for (const installation of installations) installationContributionDisposers.delete(installation);
        const tracked = pluginTracking.get(entry.item);
        tracked?.();
        pluginTracking.delete(entry.item);
      },
    });
    if (result.error !== undefined) {
      // 事务回滚只调用 install() 原样 disposer；这里补足部分已注册的贡献，并恢复被覆盖的旧 service。
      for (const stop of [...contributionStops].reverse()) stop();
      for (const slot of oldServiceSlots) {
        serviceRegistry.register({
          name: slot.name,
          value: slot.value,
          realm: slot.realm,
          order: slot.order,
          replaceable: slot.replaceable,
          required: slot.required,
          source: slot.source,
        });
      }
      throw result.error;
    }
    if (previous !== undefined && previous.status === "ACTIVE") {
      previous.status = "RETIRING";
      retireIfIdle(previous);
    }
    const state: HotGenerationState = {
      id,
      generation: hotGeneration,
      plugin,
      superseded: previous?.plugin,
      status: "ACTIVE",
      inFlight: 0,
      disposeCount: 0,
      disposers: [...result.installed.map((record) => record.dispose), ...contributionStops].map(addDisposer),
      installations,
      toolNames: plugin.contributions.flatMap((item) => item.kind === "tool" ? [item.tool.name] : []),
      serviceSlots: serviceSlotsOf(plugin),
      handle: undefined as unknown as HotPluginGeneration,
    };
    state.handle = {
      id,
      generation: hotGeneration,
      plugin,
      get superseded() { return state.superseded; },
      get status() { return state.status; },
      get inFlight() { return state.inFlight; },
      get disposeCount() { return state.disposeCount; },
      dispose: () => disposeGeneration(state),
    };
    hotGenerations.set(id, state);
    return state.handle;
  }

  function revertHotPlugin(handle: HotPluginGeneration): void {
    const state = [...hotGenerations.values()].find((item) => item.handle === handle);
    if (state === undefined || state.status === "DISPOSED") return;
    const superseded = state.superseded;
    state.status = "RETIRING";
    retireIfIdle(state);
    if (superseded !== undefined && !disposed) hotSwapPlugin(handle.id, superseded);
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
    inject: (message) => inbox.inject(message),
    setQueueMode: (mode) => inbox.setMode(mode),
    getQueueMode: () => inbox.getMode(),
    queueSize: (target) => inbox.size(target),
    // D11（延期）：框架 createCompactionListener 原语可用；facade 自动装配需要注入
    // surface/offloader 并补齐零回归测试，当前保持调用方自行订阅，按 O-03 延期。
    subscribe: (listener) => stream.subscribe(listener),
    get sessionStore() {
      return activeSessionStore;
    },
    attachSessionStore: (store) => rebindSessionStore(store),
    resumeSession: (frameId) => {
      const store = activeSessionStore;
      if (store === undefined) throw new Error("SESSION_STORE_REQUIRED: resume 需要已绑定 SessionStore");
      rebindSessionStore(store.resume(frameId));
    },
    async forkSession(fromId) {
      const store = activeSessionStore;
      if (store === undefined) throw new Error("SESSION_STORE_REQUIRED: fork 需要已绑定 SessionStore");
      const forked = await store.fork(fromId);
      rebindSessionStore(forked);
      return forked;
    },
    async truncateSession(frameId) {
      const store = activeSessionStore;
      if (store === undefined) throw new Error("SESSION_STORE_REQUIRED: truncate 需要已绑定 SessionStore");
      const truncated = await store.truncate(frameId);
      rebindSessionStore(truncated);
      return truncated;
    },
    get usageSummary() {
      return usageSummaryFrom(stream.getState().messages);
    },
    lastRunUsage: () => usageSummaryFrom(lastRunMessages),
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
    waitForIdle: () => drainLeases(),
    dispose() {
      if (disposal !== undefined) return disposal;
      disposal = (async () => {
        // 1) 停止新准入；2) abort 并 drain run/tool/listener；3) 撤销插件；4) 关闭审计。
        disposed = true;
        aborted = true;
        activeRun?.controller.abort("AGENT_DISPOSED");
        await toolLeases.close();
        await drainLeases();
        pluginManager.disposeAll();
        for (const state of [...hotGenerations.values()]) {
          state.status = "RETIRING";
          retireIfIdle(state);
        }
        pluginProviderRegistration?.();
        pluginProviderRegistration = undefined;
        for (const stop of brokerRegistrations) stop();
        brokerRegistrations.length = 0;
        await closeAuditSink();
      })();
      return disposal;
    },
    closeAdmission() {
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
    get activeLeaseCount() {
      return (activeRun === undefined ? 0 : 1) + toolLeases.activeCount;
    },
    hotSwapPlugin,
    revertHotPlugin,
    get hotPluginGenerations() {
      return [...hotGenerations.values()].map((state) => state.handle);
    },
    ...api,
    api,
    tenantScope,
    emitEffect: (meta) => effectBridge.emit(meta),
    resolveLogSink: (options) => resolveLogSink(options),
    logger,
    async runTool(call) {
      if (disposed) throw new Error("AGENT_DISPOSED: dispose 后不再接受新 runTool");
      // 与模型工具共用同一受管 registry/context：同一 hooks、wrap、审计、effects/quota、
      // timeout 与 cleanup；runToolCall 只关掉事件 sink 与消息追加。
      let invoked = false;
      const stop = pipelineRegistry.registerTool(
        descriptorFor(
          { name: call.name, execute: () => call.execute() },
          {
            verify: async (toolSignal) => {
              // commit 派发阶段已经完成安全边界检查，不再重复 backend.run。
              if (dispatchingEmission) return;
              if (isCriticalLayerDegraded(securityBackend.capabilities())) {
                throw new Error("CRITICAL_LAYER_DEGRADED");
              }
              if (toolSignal?.aborted === true) throw new Error("ABORTED");
              await securityBackend.run({ argv: [call.name] });
              invoked = true;
            },
          }
        )
      );
      // 先登记调用自己的工具，再捕获 scope：runTool 的本次调用必须命中自己的 descriptor。
      return withScope(async () => {
      try {
        const result = await activePipeline.runToolCall({
          id: `runTool-${++runToolSeq}`,
          tool: call.name,
          input: {},
        });
        if (result.isError === true || !invoked) {
          return {
            ok: false,
            reason: String(result.reason ?? "TOOL_FAILED"),
            ...(result.reconciliation === true ? { reconciliation: true } : {}),
          };
        }
        return { ok: true, value: result.output };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        stop();
      }
      });
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
      if (disposed) throw new Error("AGENT_DISPOSED: dispose 后不再解析 service");
      const frozen = dispatchScope.getStore()?.services.find(
        (slot) => slot.name === name && slot.realm === (realm ?? defaultRealm)
      );
      return frozen === undefined ? serviceRegistry.resolve(name, realm) : frozen.value;
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
    closeAudit: () => closeAuditSink(),
    createProviderStreamFn(config, fetchImpl) {
      // 注入 fetch 只能作为底层 transport；无论是否注入，都强制构造受策略约束的 OutboundClient。
      const outbound = config.outbound
        ?? createOutboundClient({ egress: egressPolicy, fetch: fetchImpl ?? globalThis.fetch });
      return createProviderStreamFn(
        {
          ...config,
          outbound,
          ...(credentialVault !== undefined ? { credentialVault } : {}),
          ...(secretBroker !== undefined ? { secretBroker } : {}),
          ...(credentialBoundary !== undefined ? { credentialBoundary } : {}),
        },
        fetchImpl
      );
    },
    providerBroker,
    registerProvider(id, streamFn, registrationOptions) {
      if (providerBroker === undefined) throw new Error("PROVIDER_BROKER_REQUIRED: 未注入 providerBroker");
      const dispose = providerBroker.register(id, streamFn, registrationOptions);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        dispose();
      };
    },
    unregisterProvider(id) {
      providerBroker?.unregister(id);
    },
    setProviderRoutes(routes) {
      providerBroker?.setRoutes(routes);
    },
    setProviderFallback(providerIds) {
      providerBroker?.setFallback(providerIds);
    },
    setProvider(id) {
      providerId = id;
    },
    setModel(model) {
      modelRef = model;
    },
  };
}
