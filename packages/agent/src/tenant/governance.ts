import { createContext, type CoeffectKey, type Context, type Disposer } from "@zeta-agent/framework";
import {
  createPrincipalResolver,
  createQuotaService,
  type Principal,
  type PrincipalInput,
  type PrincipalResolver,
  type QuotaService,
} from "@zeta-agent/capabilities";
import { createExperienceStore, type ExperienceStore } from "../research/experience";
import type { DurableEffects } from "../plugins/effects/durable";
import type { SessionStore } from "../session/store";
import type { AgentStreamFn } from "../facade";

/** 单个租户的完全隔离作用域：独立 framework context（即独立 host/system）。 */
export interface TenantScope {
  readonly principal: Principal;
  readonly realm: symbol;
  readonly context: Context;
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
  /** 缺省按 spaceId 派生稳定 realm；可替换为外部身份系统适配器。 */
  readonly resolver?: PrincipalResolver;
  /** 每租户 token 预算；缺省 100。 */
  readonly tokensPerTenant?: number;
  readonly toolCosts?: Readonly<Record<string, number>>;
  /** 各消费点的注入工厂：收到 principal 后返回该 realm 独有的实例。 */
  readonly createSessionStore?: (principal: Principal) => SessionStore | undefined;
  readonly createDurableEffects?: (principal: Principal) => DurableEffects | undefined;
  readonly createStreamFn?: (principal: Principal) => AgentStreamFn | undefined;
  readonly createExperienceStore?: (principal: Principal) => ExperienceStore;
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
  await scope.context.dispose();
}

export function createTenantGovernance(options: TenantGovernanceOptions = {}): TenantGovernance {
  const resolver = options.resolver ?? createPrincipalResolver();
  const scopes = new Map<symbol, TenantScope>();
  let disposed = false;

  function build(principal: Principal): TenantScope {
    // 每 realm 一个 root context：host 与 FiberSystem 都是全新的，生命周期互不共享。
    const context = createContext({
      uid: `tenant:${principal.spaceId}:${++contextSeed}`,
      realm: principal.realm,
    });
    const quota = createQuotaService({
      tokens: options.tokensPerTenant ?? 100,
      ...(options.toolCosts === undefined ? {} : { toolCosts: options.toolCosts }),
    });
    const sessionStore = options.createSessionStore?.(principal);
    const durableEffects = options.createDurableEffects?.(principal);
    const streamFn = options.createStreamFn?.(principal);
    const research = options.createExperienceStore?.(principal) ?? createExperienceStore();
    return {
      principal,
      realm: principal.realm,
      context,
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
    const principal = resolver(input);
    const existing = scopes.get(principal.realm);
    if (existing !== undefined) return existing;
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
