import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createContext, defineComponent, type ContextFiber } from "@zeta-agent/framework";
import {
  createPluginHotReloader,
  discoverHotReloadUnits,
  type PluginHotReloader,
} from "../plugins/hot-reload";
import type { PrincipalInput } from "@zeta-agent/capabilities";
import {
  createProfileBackend,
  resolveStructuredBackend,
  type BackendProfile,
  type StructuredExecutionBackend,
} from "@zeta-agent/security";
import {
  createAgent,
  type Agent,
  type AgentOptions,
  type AgentPlugin,
  type AgentStreamFn,
  type HotPluginGeneration,
} from "../facade";
import {
  createProviderBroker,
  type ProviderBroker,
  type ProviderBrokerOptions,
  type ProviderRegistrationOptions,
} from "../providers/broker";
import { createResourceRegistry, type ResourceEntry, type ResourceRegistry } from "../resources/registry";
import { installResourcePlugin, type ResourcePluginHandle } from "../resources/plugin";
import { createJsonlSessionStore } from "../session/jsonl-store";
import { createSqliteSessionStore } from "../session/sqlite-store";
import type { SessionStore } from "../session/store";
import {
  createFileWorkspaceStore,
  type CompactionBudget,
  type CompactionMode,
  type WorkspaceStore,
} from "@zeta-agent/agent-framework";
import {
  createTenantGovernance,
  type TenantGovernance,
  type TenantScope,
} from "../tenant/governance";
import { createExperienceStore } from "../research/experience";
import { resolveAssemblyProfile, type AssemblyProfile } from "./builtins";
import {
  createAssemblyManifest,
  type AssemblyManifest,
  type InstalledResource,
} from "./manifest";
import { diagnoseCapabilities } from "./profile";
import { diagnoseProfilePolicy, policyForProfile } from "./profile-policy";
import {
  createRuntimeProtocol,
  createStoreSessionControl,
  type RuntimeProtocol,
} from "./protocol";

export interface DefaultRuntimeOptions {
  readonly streamFn?: AgentStreamFn;
  readonly allowedDirectories?: readonly string[];
  readonly profile?: string | AssemblyProfile;
  /** 安全后端档位；与产品 profile 分离，local-safe 是默认且默认失败关闭。 */
  readonly backendProfile?: BackendProfile;
  readonly includeBuiltins?: boolean;
  readonly agentRoot?: string;
  readonly projectRoot?: string;
  readonly sessionId?: string;
  /** 显式注入 SessionStore；与 sessionStorePath 二选一。 */
  readonly sessionStore?: SessionStore;
  /** 按路径创建正式后端；不传时保持 T-10 的纯内存会话零回归。 */
  readonly sessionStorePath?: string;
  readonly sessionStoreBackend?: "jsonl" | "sqlite";
  /** 文件持久 workspace 根目录；提供后压缩块跨进程可取回。 */
  readonly workspaceStorePath?: string;
  /** 显式开启压缩并指定预算；未提供时保持既有装配零回归。 */
  readonly compactionBudget?: CompactionBudget;
  readonly compactionMode?: CompactionMode;
  /** 压缩外置块与工具输出的字节上限；与阈值联动。 */
  readonly compactionMaxOutputBytes?: number;
  readonly permissionGate?: AgentOptions["permissionGate"];
  readonly approvalChannel?: AgentOptions["approvalChannel"];
  readonly egressPolicy?: AgentOptions["egressPolicy"];
  /** principal resolver 的输入；提供后按 spaceId 解析独立 realm 作用域。 */
  readonly principalInput?: PrincipalInput;
  /** 外部持有的治理器；不传但提供 principalInput 时按 tokensPerTenant 内部创建。 */
  readonly tenantGovernance?: TenantGovernance;
  readonly tokensPerTenant?: number;
  /** 插件热重载目录；提供后用同一 ctx/root fiber 装配真实文件 watcher。 */
  readonly hotReloadDirs?: readonly string[];
  /** 显式注入 broker；缺省时由生产装配创建，所有模型请求统一经它路由。 */
  readonly providerBroker?: ProviderBroker;
  readonly providerRoutes?: ProviderBrokerOptions["routes"];
  readonly providerFallback?: ProviderBrokerOptions["fallback"];
  readonly providerRetry?: ProviderBrokerOptions["retry"];
  readonly providerObservers?: Pick<ProviderBrokerOptions, "onRoute" | "onPayload" | "onResponse" | "onProviderStreamEvent">;
  readonly providerRegistrations?: readonly {
    readonly id: string;
    readonly streamFn: AgentStreamFn;
    readonly options?: ProviderRegistrationOptions;
  }[];
  readonly provider?: string;
  readonly model?: string;
  /** 单文件嵌入资源（prompts/skills/schema）；与磁盘资源合并进同一注册表。 */
  readonly embeddedResources?: readonly ResourceEntry[];
}

export interface DefaultRuntime {
  readonly agent: Agent;
  readonly manifest: AssemblyManifest;
  readonly protocol: RuntimeProtocol;
  readonly profile: AssemblyProfile;
  readonly resources: ResourceRegistry;
  readonly sessionStore: SessionStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly services: Readonly<Record<string, unknown>>;
  readonly rootFiber: ContextFiber;
  readonly tenantScope: TenantScope | undefined;
  readonly governance: TenantGovernance | undefined;
  readonly hotReload: PluginHotReloader | undefined;
  readonly providerBroker: ProviderBroker;
  /** 真实安全后端；暴露供 profile conformance 与 shell 真实验收使用。 */
  readonly backend: StructuredExecutionBackend;
  /** 按 profile 安装的真实资源 coeffect + watcher；local-safe 不安装。 */
  readonly resourceWatcher: ResourcePluginHandle | undefined;
  dispose(): Promise<void>;
}

/**
 * 统一默认装配 loader：
 *   config（profile / 目录）→ 资源注册表发现 → manifest → facade agent → root fiber → 协议。
 * CLI 与 SDK 都调用此函数，保证 manifest、工具、服务、session 与 mode 装配完全一致。
 */
export async function createDefaultRuntime(options: DefaultRuntimeOptions = {}): Promise<DefaultRuntime> {
  const profile = resolveAssemblyProfile(options.profile);
  const policy = policyForProfile(profile);
  const allowedDirectories = options.allowedDirectories ?? [process.cwd()];
  const agentRoot = options.agentRoot ?? join(process.cwd(), ".zeta-agent");
  const projectRoot = options.projectRoot ?? process.cwd();
  // profile 声明与后端执行必须同源：显式冲突直接失败关闭，禁止两套装配。
  if (options.backendProfile !== undefined && options.backendProfile !== policy.backend) {
    throw new Error(
      `PROFILE_BACKEND_MISMATCH: ${profile} requires ${policy.backend}, got ${options.backendProfile}`
    );
  }
  const backendProfile: BackendProfile = policy.backend;
  const securityBackend = createProfileBackend(backendProfile, { allowedDirectories });
  const structuredBackend = resolveStructuredBackend(securityBackend, allowedDirectories);
  const diagnostics = [
    ...diagnoseCapabilities(profile, securityBackend.capabilities(), structuredBackend.operations),
    ...diagnoseProfilePolicy(profile),
  ];

  const resources = createResourceRegistry({
    agentRoot,
    projectRoot,
    ...(options.embeddedResources === undefined ? {} : { embedded: options.embeddedResources }),
  });

  const installed = resources.discover().entries;
  const installedResources: readonly InstalledResource[] = installed.map((entry) => ({
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    relativePath: entry.relativePath,
  }));
  const manifest = createAssemblyManifest({
    profile,
    resources: installedResources,
    diagnostics,
  });

  const ownsGovernance =
    options.tenantGovernance === undefined &&
    (options.principalInput !== undefined || policy.tenantMode === "multi-tenant");
  // runtime 自身只承载一个 principal；multi-tenant profile 强制 origin 与 per-realm 工厂。
  const governance = options.tenantGovernance ?? (ownsGovernance
    ? createTenantGovernance({
        mode: policy.tenantMode,
        ...(policy.tenantMode === "multi-tenant"
          ? { createExperienceStore: () => createExperienceStore() }
          : {}),
        ...(options.tokensPerTenant === undefined ? {} : { tokensPerTenant: options.tokensPerTenant }),
      })
    : undefined);
  const tenantScope = governance?.resolve(options.principalInput ?? {});

  // local-safe 保持 T-10 内存零回归；其余 profile 默认使用真实持久 SessionStore。
  const sessionStorePath =
    options.sessionStorePath ?? (policy.persistentSession ? join(agentRoot, "session.jsonl") : undefined);
  if (sessionStorePath !== undefined) mkdirSync(dirname(sessionStorePath), { recursive: true });
  const sessionId =
    options.sessionId ??
    (sessionStorePath === undefined
      ? `zeta-${process.pid}`
      : `zeta:${createHash("sha256").update(sessionStorePath).digest("hex").slice(0, 16)}`);
  const explicitSessionStore = options.sessionStore ?? tenantScope?.sessionStore;
  const ownsSessionStore = explicitSessionStore === undefined && sessionStorePath !== undefined;
  const sessionStore =
    explicitSessionStore ??
    (sessionStorePath === undefined
      ? undefined
      : options.sessionStoreBackend === "sqlite"
        ? createSqliteSessionStore({ path: sessionStorePath, sessionId })
        : createJsonlSessionStore({ path: sessionStorePath, sessionId }));

  const providerBroker = options.providerBroker ?? createProviderBroker({
    ...(options.providerRoutes === undefined ? {} : { routes: options.providerRoutes }),
    ...(options.providerFallback === undefined ? {} : { fallback: options.providerFallback }),
    ...(options.providerRetry === undefined ? {} : { retry: options.providerRetry }),
    ...(options.providerObservers ?? {}),
  });
  for (const registration of options.providerRegistrations ?? []) {
    providerBroker.register(registration.id, registration.streamFn, registration.options);
  }

  const workspaceStore = options.workspaceStorePath === undefined
    ? undefined
    : createFileWorkspaceStore({ root: options.workspaceStorePath });
  const compactionEnabled = options.compactionBudget !== undefined || workspaceStore !== undefined;
  const compaction = compactionEnabled
    ? {
        budget: options.compactionBudget ?? { totalContextLimit: 128_000, compactionThreshold: 96_000 },
        ...(options.compactionMode === undefined ? {} : { mode: options.compactionMode }),
        ...(workspaceStore === undefined ? {} : { workspaceStore }),
        ...(options.compactionMaxOutputBytes === undefined ? {} : { maxOutputBytes: options.compactionMaxOutputBytes }),
      }
    : undefined;
  const agent = createAgent({
    tenantScope,
    streamFn: options.streamFn,
    providerBroker,
    ...(compaction === undefined ? {} : { compaction }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    allowedDirectories,
    includeBuiltins: options.includeBuiltins,
    securityBackend,
    structuredBackend,
    backendProfile,
    assemblyProfile: profile,
    services: [...manifest.services, ...manifest.session],
    permissionGate: options.permissionGate,
    approvalChannel: options.approvalChannel,
    egressPolicy: options.egressPolicy,
    sessionStore,
  });

  const sessionControl = sessionStore === undefined
    ? undefined
    : createStoreSessionControl({
        store: sessionStore,
        agent,
        workspaceStore,
        ...(options.compactionMaxOutputBytes === undefined ? {} : { maxOutputBytes: options.compactionMaxOutputBytes }),
      });
  const protocol = createRuntimeProtocol(agent, sessionId, sessionControl);

  // root fiber 持有运行时生命周期；dispose 是唯一的逆操作。
  const ctx = createContext({ uid: `zeta:runtime:${sessionId}` });
  const rootFiber = ctx.use(
    defineComponent({
      name: "zeta:runtime",
      apply: () => () => {
        // 协议与 agent 无宿主资源；生命周期逆由 ctx.dispose 统一驱动。
      },
    })
  );
  await rootFiber.ready;

  /** 资源 coeffect/watcher 按 profile 安装；local-safe 收敛不安装。 */
  const resourceWatcher = policy.resourceWatcher
    ? installResourcePlugin({ ctx, registry: resources, roots: [agentRoot, projectRoot] })
    : undefined;

  const hotReloadUnits =
    options.hotReloadDirs === undefined || options.hotReloadDirs.length === 0
      ? []
      : discoverHotReloadUnits(options.hotReloadDirs);
  /** 求值产物只有带 contributions 的对象才是可安装插件；纯数据导出维持值投影语义。 */
  const asHotPlugin = (value: unknown): AgentPlugin | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<AgentPlugin>;
    if (!Array.isArray(candidate.contributions)) return undefined;
    return {
      kind: "AgentPlugin",
      name: typeof candidate.name === "string" ? candidate.name : "hot-plugin",
      contributions: candidate.contributions,
      install: typeof candidate.install === "function"
        ? candidate.install.bind(candidate)
        : () => () => {},
      ...(candidate.source === undefined ? {} : { source: candidate.source }),
      ...(candidate.trusted === undefined ? {} : { trusted: candidate.trusted }),
      ...(candidate.digest === undefined ? {} : { digest: candidate.digest }),
    };
  };
  const hotReload =
    hotReloadUnits.length === 0
      ? undefined
      : createPluginHotReloader<HotPluginGeneration>({
          ctx,
          parent: rootFiber,
          root: options.hotReloadDirs![0],
          units: hotReloadUnits,
          auto: true,
          applyPlugin: (unit, instance) => {
            const plugin = asHotPlugin(instance.value);
            return plugin === undefined ? undefined : agent.hotSwapPlugin(unit.id, plugin);
          },
          revertPlugin: (_unit, applied) => agent.revertHotPlugin(applied),
        });
  if (hotReload !== undefined) await hotReload.install(hotReloadUnits);

  const services: Record<string, unknown> = {};
  for (const name of manifest.services) {
    if (name === "resources:watcher") {
      if (resourceWatcher === undefined) throw new Error("RESOURCE_WATCHER_UNAVAILABLE");
      services[name] = resourceWatcher;
    } else if (name === "session:control") {
      if (sessionControl === undefined) throw new Error("SESSION_CONTROL_UNAVAILABLE");
      services[name] = sessionControl;
    } else {
      // skills / prompts / themes registry 都指向同一真实注册表，不是占位值。
      services[name] = resources;
    }
  }
  for (const name of manifest.session) {
    services[name] = {
      state: () => agent.state,
      reset: () => agent.reset(),
      ...(sessionStore === undefined ? {} : { store: sessionStore }),
    };
  }

  let disposal: Promise<void> | undefined;

  return {
    agent,
    manifest,
    protocol,
    profile,
    resources,
    sessionStore,
    workspaceStore,
    services,
    rootFiber,
    tenantScope,
    governance,
    hotReload,
    providerBroker,
    backend: securityBackend,
    resourceWatcher,
    dispose() {
      if (disposal !== undefined) return disposal;
      // 所有权顺序：停止新准入与 watcher → agent 排空 run/tool/listener/插件/审计
      // → ctx fiber → session → tenant governance → backend。重复调用共享同一 promise。
      disposal = (async () => {
        agent.closeAdmission();
        resourceWatcher?.close();
        await hotReload?.close();
        await agent.dispose();
        await ctx.dispose();
        if (ownsSessionStore) sessionStore?.close();
        // 外部注入的 governance 由调用方持有；只回收本 runtime 创建的治理器。
        if (ownsGovernance) await governance?.dispose();
        securityBackend.dispose();
      })();
      return disposal;
    },
  };
}
