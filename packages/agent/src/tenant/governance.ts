import {
  createContext,
  createHost,
  type CoeffectKey,
  type Context,
  type Disposer,
  type Host,
  type JobRunner,
  type RolloutController,
  type Store,
} from "@zeta-agent/framework";
import {
  createPrincipalResolver,
  createQuotaService,
  hasOrigin,
  quotaKey,
  TENANT_ORIGIN_REQUIRED,
  type Principal,
  type PrincipalInput,
  type PrincipalResolver,
  type QuotaService,
} from "@zeta-agent/capabilities";
import { createExperienceStore, type ExperienceStore } from "../research/experience";
import type { DurableEffects } from "../plugins/effects/durable";
import type { SessionStore } from "../session/store";
import type { AgentStreamFn } from "../facade";

/**
 * 运行模式必须显式声明：
 * - multi-tenant（缺省）：强制 origin，且必须注入 per-realm 工厂，缺一即拒绝。
 * - single-tenant：显式的单租户默认路径；允许缺省 origin/research 工厂，
 *   但只能由一个真实声明它的装配点使用，不得作为共享回退蒙混。
 */
export type TenantGovernanceMode = "multi-tenant" | "single-tenant";

/** 单个租户的完全隔离作用域：独立 framework context（即独立 host/system）。 */
export interface TenantScope {
  readonly principal: Principal;
  readonly realm: symbol;
  readonly context: Context;
  /** 对象 host 复用本租户 context（T-05 fiber）与 principal/realm（T-13）。 */
  readonly objectHost: Host;
  /** 每租户独立对象数据面：持久化、作业与跨 host rollout 不共享状态。 */
  readonly objectStore: Store | undefined;
  readonly objectJobs: JobRunner | undefined;
  readonly objectRollout: RolloutController | undefined;
  readonly quota: QuotaService;
  readonly sessionStore: SessionStore | undefined;
  readonly durableEffects: DurableEffects | undefined;
  readonly streamFn: AgentStreamFn | undefined;
  readonly research: ExperienceStore;
  provide<T>(key: CoeffectKey<T>, value: T): Disposer;
  get<T>(key: CoeffectKey<T>): T;
  set<T>(key: CoeffectKey<T>, value: T): Disposer;
  on(name: string, listener: (payload: unknown) => void): Disposer;
  emit(name: string, payload?: unknown): void;
  notify(keys?: readonly CoeffectKey<any>[]): Promise<void>;
}

export interface TenantGovernanceOptions {
  /** 显式模式；缺省 multi-tenant，缺 origin/工厂时失败关闭。 */
  readonly mode?: TenantGovernanceMode;
  /** 仅 single-tenant 模式有效：缺省 origin。 */
  readonly singleTenantSpaceId?: string;
  /** 仅 single-tenant 模式有效：缺省 userId。 */
  readonly singleTenantUserId?: string;
  /** 缺省按 spaceId 派生稳定 realm；可替换为外部身份系统适配器。仍受 origin 门禁约束。 */
  readonly resolver?: PrincipalResolver;
  /** 每租户 token 预算；缺省 100。 */
  readonly tokensPerTenant?: number;
  /** 每租户 qps 上限；缺省不限。 */
  readonly qpsPerTenant?: number;
  /** 注入配额时钟，便于确定性验证 qps 秒窗。 */
  readonly quotaClock?: () => number;
  readonly toolCosts?: Readonly<Record<string, number>>;
  /** 各消费点的注入工厂：收到 principal 后返回该 realm 独有的实例。 */
  readonly createSessionStore?: (principal: Principal) => SessionStore | undefined;
  readonly createDurableEffects?: (principal: Principal) => DurableEffects | undefined;
  readonly createStreamFn?: (principal: Principal) => AgentStreamFn | undefined;
  /** multi-tenant 模式必需：缺此工厂 resolve 显式拒绝（TENANT_FACTORY_REQUIRED）。 */
  readonly createExperienceStore?: (principal: Principal) => ExperienceStore;
  readonly createObjectStore?: (principal: Principal) => Store | undefined;
  readonly createObjectJobs?: (principal: Principal) => JobRunner | undefined;
  readonly createObjectRollout?: (principal: Principal) => RolloutController | undefined;
}

export interface TenantGovernance {
  resolve(input?: PrincipalInput): TenantScope;
  readonly scopes: ReadonlyMap<symbol, TenantScope>;
  /** 只在目标 realm 内 notify，兄弟 realm 的 fiber 不被触达。 */
  notify(realm: symbol, keys?: readonly CoeffectKey<any>[]): Promise<void>;
  disposeRealm(realm: symbol): Promise<void>;
  dispose(): Promise<void>;
}

let contextSeed = 0;

async function disposeScope(scope: TenantScope): Promise<void> {
  scope.sessionStore?.close();
  await scope.objectJobs?.close();
  await scope.objectStore?.close();
  await scope.objectRollout?.close();
  await scope.objectHost.close();
  await scope.context.dispose();
}

export function createTenantGovernance(options: TenantGovernanceOptions = {}): TenantGovernance {
  const mode: TenantGovernanceMode = options.mode ?? "multi-tenant";
  const singleTenant = mode === "single-tenant";
  const resolver =
    options.resolver ??
    createPrincipalResolver(
      singleTenant
        ? {
            requireOrigin: false,
            defaultSpaceId: options.singleTenantSpaceId ?? "default",
            defaultUserId: options.singleTenantUserId ?? "system",
          }
        : {}
    );
  // 唯一的 research 工厂：multi-tenant 缺省为 undefined（resolve 拒绝），
  // single-tenant 显式构造一个内置默认工厂。build 内不再有 ?? createExperienceStore() 共享回退。
  const researchFactory =
    options.createExperienceStore ?? (singleTenant ? () => createExperienceStore() : undefined);
  const scopes = new Map<symbol, TenantScope>();
  let disposed = false;

  function build(principal: Principal): TenantScope {
    if (researchFactory === undefined) {
      // 只传 principal 不传 per-realm 工厂：显式拒绝，不静默使用共享实例/undefined。
      throw new Error("TENANT_FACTORY_REQUIRED: createExperienceStore");
    }
    // 每 realm 一个 root context：host 与 FiberSystem 都是全新的，生命周期互不共享。
    const context = createContext({
      uid: `tenant:${principal.spaceId}:${++contextSeed}`,
      realm: principal.realm,
    });
    const objectHost = createHost({
      context,
      principal: { userId: principal.userId, spaceId: principal.spaceId, realm: principal.realm },
      realm: principal.realm,
    });
    const quota = createQuotaService({
      tokens: options.tokensPerTenant ?? 100,
      ...(options.toolCosts === undefined ? {} : { toolCosts: options.toolCosts }),
      ...(options.qpsPerTenant === undefined ? {} : { qps: options.qpsPerTenant }),
      ...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }),
    });
    // 配额以 coeffect key 提供到该 realm 的 context；providerVersions/绑定按 realm 分区。
    context.provide(quotaKey, quota);
    const sessionStore = options.createSessionStore?.(principal);
    const durableEffects = options.createDurableEffects?.(principal);
    const streamFn = options.createStreamFn?.(principal);
    const research = researchFactory(principal);
    const objectStore = options.createObjectStore?.(principal);
    const objectJobs = options.createObjectJobs?.(principal);
    const objectRollout = options.createObjectRollout?.(principal);
    return {
      principal,
      realm: principal.realm,
      context,
      objectHost,
      objectStore,
      objectJobs,
      objectRollout,
      quota,
      sessionStore,
      durableEffects,
      streamFn,
      research,
      provide: (key, value) => context.provide(key, value),
      get: (key) => context.get(key),
      set: (key, value) => context.set(key, value),
      on: (name, listener) => context.on(name, listener),
      emit: (name, payload) => context.emit(name, payload),
      notify: (keys) => context.notify(keys),
    };
  }

  function resolve(input: PrincipalInput = {}): TenantScope {
    if (disposed) throw new Error("TENANT_GOVERNANCE_DISPOSED");
    // multi-tenant 语义强制 origin：自定义 resolver 也不能绕过这一门禁。
    if (!singleTenant && !hasOrigin(input)) throw new Error(TENANT_ORIGIN_REQUIRED);
    const principal = resolver(input);
    if (!hasOrigin(principal)) throw new Error(TENANT_ORIGIN_REQUIRED);
    const existing = scopes.get(principal.realm);
    if (existing !== undefined) {
      // 同一 realm 不允许换绑身份，避免跨 principal 复用同一 scope/host。
      if (existing.principal.userId !== principal.userId) throw new Error("TENANT_PRINCIPAL_MISMATCH");
      return existing;
    }
    const scope = build(principal);
    scopes.set(principal.realm, scope);
    return scope;
  }

  return {
    resolve,
    scopes,
    async notify(realm, keys) {
      const scope = scopes.get(realm);
      if (scope === undefined) throw new Error("REALM_SCOPE_MISSING");
      await scope.context.notify(keys);
    },
    async disposeRealm(realm) {
      const scope = scopes.get(realm);
      if (scope === undefined) return;
      scopes.delete(realm);
      await disposeScope(scope);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const all = [...scopes.values()];
      scopes.clear();
      await Promise.all(all.map(disposeScope));
    },
  };
}
