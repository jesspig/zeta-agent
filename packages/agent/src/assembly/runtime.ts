import { join } from "node:path";
import { createContext, defineComponent, type ContextFiber } from "@zeta-agent/framework";
import {
  createPluginHotReloader,
  discoverHotReloadUnits,
  type PluginHotReloader,
} from "../plugins/hot-reload";
import type { PrincipalInput } from "@zeta-agent/capabilities";
import {
  createLocalSafeBackend,
  createProfileBackend,
  resolveStructuredBackend,
  type BackendProfile,
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
import { createResourceRegistry, type ResourceRegistry } from "../resources/registry";
import { createJsonlSessionStore } from "../session/jsonl-store";
import { createSqliteSessionStore } from "../session/sqlite-store";
import type { SessionStore } from "../session/store";
import {
  createTenantGovernance,
  type TenantGovernance,
  type TenantScope,
} from "../tenant/governance";
import { resolveAssemblyProfile, type AssemblyProfile } from "./builtins";
import {
  createAssemblyManifest,
  type AssemblyManifest,
  type InstalledResource,
} from "./manifest";
import { diagnoseCapabilities } from "./profile";
import { createRuntimeProtocol, type RuntimeProtocol } from "./protocol";

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
}

export interface DefaultRuntime {
  readonly agent: Agent;
  readonly manifest: AssemblyManifest;
  readonly protocol: RuntimeProtocol;
  readonly profile: AssemblyProfile;
  readonly resources: ResourceRegistry;
  readonly sessionStore: SessionStore | undefined;
  readonly services: Readonly<Record<string, unknown>>;
  readonly rootFiber: ContextFiber;
  readonly tenantScope: TenantScope | undefined;
  readonly governance: TenantGovernance | undefined;
  readonly hotReload: PluginHotReloader | undefined;
  readonly providerBroker: ProviderBroker;
  dispose(): Promise<void>;
}

/**
 * 统一默认装配 loader：
 *   config（profile / 目录）→ 资源注册表发现 → manifest → facade agent → root fiber → 协议。
 * CLI 与 SDK 都调用此函数，保证 manifest、工具、服务、session 与 mode 装配完全一致。
 */
export async function createDefaultRuntime(options: DefaultRuntimeOptions = {}): Promise<DefaultRuntime> {
  const profile = resolveAssemblyProfile(options.profile);
  const allowedDirectories = options.allowedDirectories ?? [process.cwd()];
  const backendProfile = options.backendProfile ?? "local-safe";
  const securityBackend =
    backendProfile === "local-safe"
      ? createLocalSafeBackend({ allowedDirectories })
      : createProfileBackend(backendProfile, { allowedDirectories });
  const structuredBackend = resolveStructuredBackend(securityBackend, allowedDirectories);
  const diagnostics = diagnoseCapabilities(
    profile,
    securityBackend.capabilities(),
    structuredBackend.operations
  );

  const resources = createResourceRegistry({
    agentRoot: options.agentRoot ?? join(process.cwd(), ".zeta-agent"),
    projectRoot: options.projectRoot ?? process.cwd(),
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

  const ownsGovernance = options.tenantGovernance === undefined && options.principalInput !== undefined;
  // runtime 自身只承载一个 principal：显式声明单租户默认路径，不借共享回退。
  const governance = options.tenantGovernance ?? (ownsGovernance
    ? createTenantGovernance({
        mode: "single-tenant",
        ...(options.tokensPerTenant === undefined ? {} : { tokensPerTenant: options.tokensPerTenant }),
      })
    : undefined);
  const tenantScope = governance?.resolve(options.principalInput ?? {});

  const sessionId = options.sessionId ?? `zeta-${process.pid}`;
  const explicitSessionStore = options.sessionStore ?? tenantScope?.sessionStore;
  const ownsSessionStore = explicitSessionStore === undefined && options.sessionStorePath !== undefined;
  const sessionStore =
    explicitSessionStore ??
    (options.sessionStorePath === undefined
      ? undefined
      : options.sessionStoreBackend === "sqlite"
        ? createSqliteSessionStore({ path: options.sessionStorePath, sessionId })
        : createJsonlSessionStore({ path: options.sessionStorePath, sessionId }));

  const providerBroker = options.providerBroker ?? createProviderBroker({
    ...(options.providerRoutes === undefined ? {} : { routes: options.providerRoutes }),
    ...(options.providerFallback === undefined ? {} : { fallback: options.providerFallback }),
    ...(options.providerRetry === undefined ? {} : { retry: options.providerRetry }),
    ...(options.providerObservers ?? {}),
  });
  for (const registration of options.providerRegistrations ?? []) {
    providerBroker.register(registration.id, registration.streamFn, registration.options);
  }

  const agent = createAgent({
    tenantScope,
    streamFn: options.streamFn,
    providerBroker,
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

  const protocol = createRuntimeProtocol(agent, sessionId);

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
    services[name] = resources;
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
    services,
    rootFiber,
    tenantScope,
    governance,
    hotReload,
    providerBroker,
    dispose() {
      if (disposal !== undefined) return disposal;
      // 所有权顺序：停止新准入与 watcher → agent 排空 run/tool/listener/插件/审计
      // → ctx fiber → session → tenant governance → backend。重复调用共享同一 promise。
      disposal = (async () => {
        agent.closeAdmission();
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
