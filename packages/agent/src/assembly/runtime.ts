import { join } from "node:path";
import { createContext, defineComponent, type ContextFiber } from "@zeta-agent/framework";
import {
  createLocalSafeBackend,
  createProfileBackend,
  resolveStructuredBackend,
  type BackendProfile,
} from "@zeta-agent/security";
import { createAgent, type Agent, type AgentOptions, type AgentStreamFn } from "../facade";
import { createResourceRegistry, type ResourceRegistry } from "../resources/registry";
import { createJsonlSessionStore } from "../session/jsonl-store";
import { createSqliteSessionStore } from "../session/sqlite-store";
import type { SessionStore } from "../session/store";
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

  const sessionId = options.sessionId ?? `zeta-${process.pid}`;
  const ownsSessionStore = options.sessionStore === undefined && options.sessionStorePath !== undefined;
  const sessionStore =
    options.sessionStore ??
    (options.sessionStorePath === undefined
      ? undefined
      : options.sessionStoreBackend === "sqlite"
        ? createSqliteSessionStore({ path: options.sessionStorePath, sessionId })
        : createJsonlSessionStore({ path: options.sessionStorePath, sessionId }));

  const agent = createAgent({
    streamFn: options.streamFn,
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

  return {
    agent,
    manifest,
    protocol,
    profile,
    resources,
    sessionStore,
    services,
    rootFiber,
    async dispose() {
      await ctx.dispose();
      if (ownsSessionStore) sessionStore?.close();
      securityBackend.dispose();
    },
  };
}
