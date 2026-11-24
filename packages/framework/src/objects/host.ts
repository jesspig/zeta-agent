import { createContext, defineComponent, type Context, type ContextFiber } from "../context";
import type { Contract } from "./contract";
import { assertContract } from "./contract";
import {
  AdmissionError,
  assertAdmitted,
  decideAdmission,
  type AdmissionContext,
  type AdmissionDecision,
  type AdmissionPolicy,
  type ObjectOrigin,
  type ObjectPrincipal,
} from "./admission";
import type { Facet, FacetHost, FacetSelf, ObjectFactory, ServeOptions } from "./facet";
import { isFactoryResult } from "./facet";
import { createReference, type Reference, type ReferenceSnapshot, type ReferenceState } from "./reference";
import {
  classifyObjectError,
  createObjectTelemetry,
  ObjectTimeoutError,
  type ObjectEvent,
  type ObjectTelemetry,
} from "./telemetry";

export interface LoadedFacet {
  readonly name: string;
  readonly facet: Facet<any>;
}

export interface HostOptions {
  /** 复用 T-05  fiber 系统；缺省自建一个 context。 */
  readonly context?: Context;
  readonly principal?: ObjectPrincipal;
  readonly realm?: symbol;
  readonly telemetry?: ObjectTelemetry;
  readonly onError?: (error: unknown, event: ObjectEvent) => void;
  /** 新调用等待新代码的上限（ms）。 */
  readonly reloadDrainTimeoutMs?: number;
}

export interface LoadReport {
  readonly loaded: string[];
}

export interface ReloadOptions {
  readonly drainTimeoutMs?: number;
}

export interface ReloadReport {
  readonly restarted: string[];
  readonly retried: string[];
  readonly ended: string[];
  readonly parked: string[];
  readonly failed: string[];
}

export interface Host {
  /** 直接声明 provider（等价于在 facet setup 内调用 host.serve）。 */
  serve<T>(contract: Contract<any, any>, factory: ObjectFactory<any, T>, options?: ServeOptions<any>): void;
  load(facets: readonly LoadedFacet[]): Promise<LoadReport>;
  /** 取得对象引用：先 admission，再 route，最后绑定当前 attempt。 */
  get<T>(contract: Contract<any, any>, params?: unknown, context?: AdmissionContext): Promise<Reference<T>>;
  /** 与 get 相同，但显式持有（用于常驻消费点）。 */
  hold<T>(contract: Contract<any, any>, params?: unknown, context?: AdmissionContext): Promise<Reference<T>>;
  reload(facets?: readonly LoadedFacet[], options?: ReloadOptions): Promise<ReloadReport>;
  references<T>(contract: Contract<any, any>): readonly Reference<T>[];
  /** route 门禁：realm/origin/grant 在路由点强制。 */
  route(contract: Contract<any, any>, context?: AdmissionContext): AdmissionDecision;
  readonly telemetry: ObjectTelemetry;
  close(): Promise<void>;
}

interface ProviderDef<T> {
  readonly contract: Contract<any, any>;
  readonly factory: ObjectFactory<any, T>;
  readonly options: ServeOptions<any>;
  readonly facetName: string;
  readonly codeKey: string;
}

interface Lease<T> {
  released: boolean;
  reference: Reference<T>;
}

interface Attempt<T> {
  readonly generation: number;
  readonly contract: Contract<any, any>;
  readonly params: unknown;
  readonly provider: ProviderDef<T>;
  readonly callContext: AdmissionContext;
  readonly ready: Promise<void>;
  state: ReferenceState;
  value: T | undefined;
  error?: unknown;
  reason?: string;
  readonly leases: Set<Lease<T>>;
  readonly stateListeners: Set<() => void>;
  readonly depListeners: Set<() => void>;
  retired: boolean;
  disposed: boolean;
  fiber?: ContextFiber;
  resolveReady: () => void;
}

interface Instance {
  readonly key: string;
  readonly contract: Contract<any, any>;
  readonly params: unknown;
  current: Attempt<any>;
  readonly retired: Set<Attempt<any>>;
  gate: Promise<void> | null;
  releaseGate: (() => void) | null;
}

interface InternalConfig<T> {
  readonly params: unknown;
  readonly callContext: AdmissionContext;
  readonly attempt: Attempt<T>;
}

function stableKey(contract: Contract<any, any>, params: unknown): string {
  const encode = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
      .join(",")}}`;
  };
  return `${contract.name}@${contract.version}:${encode(params)}`;
}

function baseContext(options: HostOptions, principal?: ObjectPrincipal): AdmissionContext {
  const owner = principal ?? options.principal;
  return owner === undefined ? {} : { principal: owner };
}

function mergeContext(base: AdmissionContext, call?: AdmissionContext): AdmissionContext {
  if (call === undefined) return base;
  return {
    ...base,
    ...call,
    ...(base.principal === undefined ? {} : { principal: call.principal ?? base.principal }),
  };
}

export function createHost(options: HostOptions = {}): Host {
  const context = options.context ?? createContext({ realm: options.realm });
  const telemetry = options.telemetry ?? createObjectTelemetry();
  const drainMs = options.reloadDrainTimeoutMs ?? 5000;
  const ownContext = options.context === undefined;

  const providers = new Map<string, ProviderDef<any>>();
  const instances = new Map<string, Instance>();
  /** contract fingerprint → 依赖转 live 时唤醒 park 的监听器。 */
  const liveListeners = new Map<string, Set<() => void>>();
  let closed = false;
  let generationSeed = 0;

  function emit(event: Omit<ObjectEvent, "ts">): void {
    const full: ObjectEvent = { ts: Date.now(), ...event };
    telemetry.emit(full);
  }

  function errorEvent(
    kind: ObjectEvent["kind"],
    error: unknown,
    contract?: Contract<any, any>,
    generation?: number,
    realm?: symbol
  ): void {
    const event: Omit<ObjectEvent, "ts"> = {
      kind: "error",
      errorClass: classifyObjectError(error),
      detail: `${kind}:${contract?.name ?? ""}:${error instanceof Error ? error.message : String(error)}`,
      ...(contract === undefined ? {} : { contract: contract.name }),
      ...(generation === undefined ? {} : { generation }),
      ...(realm === undefined ? {} : { realm: realm.toString() }),
    };
    emit(event);
    options.onError?.(error, { ts: Date.now(), ...event });
  }

  function setState<T>(attempt: Attempt<T>, next: ReferenceState, extra?: { error?: unknown; reason?: string }): void {
    if (attempt.state === next && extra === undefined) return;
    attempt.state = next;
    if (extra?.error !== undefined) attempt.error = extra.error;
    if (extra?.reason !== undefined) attempt.reason = extra.reason;
    attempt.resolveReady();
    if (next === "live" && attempt.contract !== undefined) {
      for (const listener of [...(liveListeners.get(attempt.contract.fingerprint) ?? [])]) listener();
    }
    for (const listener of [...attempt.stateListeners]) listener();
  }

  function snapshot<T>(attempt: Attempt<T>): ReferenceSnapshot<T> {
    return {
      state: attempt.state,
      value: attempt.state === "live" || attempt.state === "loading" ? attempt.value : undefined,
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      generation: attempt.generation,
    };
  }

  function synthetic<T>(
    state: ReferenceState,
    contract: Contract<any, any> | undefined,
    generation: number,
    extra?: { error?: unknown; reason?: string }
  ): Attempt<T> {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const attempt: Attempt<T> = {
      generation,
      contract: contract as Contract<any, any>,
      params: undefined,
      provider: undefined as unknown as ProviderDef<T>,
      callContext: {},
      ready,
      state,
      value: undefined,
      ...(extra?.error === undefined ? {} : { error: extra.error }),
      ...(extra?.reason === undefined ? {} : { reason: extra.reason }),
      leases: new Set(),
      stateListeners: new Set(),
      depListeners: new Set(),
      retired: false,
      disposed: false,
      resolveReady,
    };
    resolveReady();
    return attempt;
  }

  function isLive(contract: Contract<any, any>): boolean {
    for (const instance of instances.values()) {
      if (instance.current.contract.fingerprint !== contract.fingerprint) continue;
      if (instance.current.state === "live") return true;
    }
    return false;
  }

  function disposeAttempt<T>(attempt: Attempt<T>): void {
    if (attempt.disposed) return;
    attempt.disposed = true;
    if (attempt.fiber !== undefined) void attempt.fiber.remove();
    setState(attempt, "ended");
  }

  function maybeDispose<T>(attempt: Attempt<T>): void {
    if (attempt.retired && attempt.leases.size === 0 && attempt.fiber !== undefined) {
      disposeAttempt(attempt);
    }
  }

  function bind<T>(attempt: Attempt<T>, owner: "get" | "hold"): Reference<T> {
    const lease: Lease<T> = { released: false, reference: undefined as unknown as Reference<T> };
    const reference = createReference<T>({
      snapshot: () =>
        lease.released
          ? { state: "ended" as const, value: undefined, generation: attempt.generation }
          : snapshot(attempt),
      ready: attempt.ready,
      get released() {
        return lease.released;
      },
      release() {
        if (lease.released) return;
        lease.released = true;
        attempt.leases.delete(lease);
        emit({
          kind: "release",
          ...(attempt.contract === undefined ? {} : { contract: attempt.contract.name }),
          generation: attempt.generation,
        });
        maybeDispose(attempt);
      },
    });
    lease.reference = reference;
    attempt.leases.add(lease);
    emit({
      kind: owner,
      ...(attempt.contract === undefined ? {} : { contract: attempt.contract.name }),
      generation: attempt.generation,
      ...(attempt.callContext.principal === undefined
        ? {}
        : { principal: attempt.callContext.principal.userId, realm: attempt.callContext.principal.realm.toString() }),
    });
    return reference;
  }

  function startFiber<T>(attempt: Attempt<T>, instance: Instance): void {
    const { provider, callContext, params } = attempt;
    attempt.stateListeners.clear();
    const self: FacetSelf = {
      principal: callContext.principal,
      async get<D>(contract: Contract<any, any>, dependencyParams?: unknown, dependencyContext?: AdmissionContext) {
        return await acquire<D>(contract, dependencyParams, mergeContext(callContext, dependencyContext));
      },
    };
    const component = defineComponent<InternalConfig<T>>({
      name: `object:${provider.contract.name}`,
      version: provider.options.version ?? provider.contract.version,
      inject: [],
      provide: [],
      apply: async (_ctx, config) => {
        // factory 点再强制一次：即便调用方绕过 route，也不会为被拒身份产出值。
        assertAdmitted(decideAdmission(config.callContext, provider.options.admission));
        const result = await provider.factory(config.params, self, config.callContext);
        const value = isFactoryResult<T>(result) ? result.value : (result as T);
        const dispose = isFactoryResult<T>(result) ? result.dispose : undefined;
        config.attempt.value = value;
        return () => {
          if (dispose !== undefined) return dispose();
        };
      },
    });
    const fiber = context.use(component, { params, callContext, attempt });
    attempt.fiber = fiber;
    void fiber.ready.then(
      () => {
        if (fiber.state.kind === "FAILED") {
          setState(attempt, "failed", { error: fiber.state.error });
          errorEvent("get", fiber.state.error, provider.contract, attempt.generation, callContext.principal?.realm);
        } else if (fiber.state.kind === "ACTIVE") {
          setState(attempt, "live");
        }
      },
      (error: unknown) => {
        setState(attempt, "failed", { error });
        errorEvent("get", error, provider.contract, attempt.generation, callContext.principal?.realm);
      }
    );
    instance.current = attempt;
  }

  function startAttempt<T>(instance: Instance, provider: ProviderDef<T>, callContext: AdmissionContext, generation: number): Attempt<T> {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const attempt: Attempt<T> = {
      generation,
      contract: provider.contract,
      params: instance.params,
      provider,
      callContext,
      ready,
      state: "loading",
      value: undefined,
      leases: new Set(),
      stateListeners: new Set(),
      depListeners: new Set(),
      retired: false,
      disposed: false,
      resolveReady,
    };

    const missing = (provider.options.requires ?? []).filter((contract) => !isLive(contract));
    if (missing.length > 0) {
      // park：依赖未就绪不启动 factory；依赖转 live 后自动重试，失败不保留半成品值。
      attempt.reason = `PARKED:${missing.map((contract) => contract.name).join(",")}`;
      emit({
        kind: "park",
        contract: provider.contract.name,
        generation,
        detail: attempt.reason,
      });
      let armed = true;
      const tryResume = () => {
        if (!armed || attempt.retired) return;
        if ((provider.options.requires ?? []).every((required) => isLive(required))) {
          armed = false;
          for (const detach of [...attempt.depListeners]) detach();
          startFiber(attempt, instance);
        }
      };
      for (const contract of missing) {
        const listeners = liveListeners.get(contract.fingerprint) ?? new Set<() => void>();
        listeners.add(tryResume);
        liveListeners.set(contract.fingerprint, listeners);
        attempt.depListeners.add(() => {
          listeners.delete(tryResume);
        });
      }
      attempt.stateListeners.add(tryResume);
      // 若依赖此刻其实已就绪（枚举竞态），直接启动。
      tryResume();
      return attempt;
    }

    startFiber(attempt, instance);
    return attempt;
  }

  function route(contract: Contract<any, any>, context: AdmissionContext = {}): AdmissionDecision {
    assertContract(contract);
    if (closed) return { kind: "deny", reason: "GRANT_REVOKED", detail: "HOST_CLOSED" };
    const provider = providers.get(contract.fingerprint);
    if (provider === undefined) return { kind: "deny", reason: "RESOURCE_FORBIDDEN", detail: "NO_PROVIDER" };
    const owner = baseContext(options, context.principal);
    const joined = mergeContext(owner, context);
    const options2 = provider.options;
    if (options2.realm !== undefined && joined.principal?.realm !== options2.realm) {
      return { kind: "deny", reason: "REALM_MISMATCH", detail: options2.realm.toString() };
    }
    if (
      options2.principal !== undefined &&
      (joined.principal === undefined ||
        joined.principal.userId !== options2.principal.userId ||
        joined.principal.spaceId !== options2.principal.spaceId)
    ) {
      return { kind: "deny", reason: "PRINCIPAL_MISMATCH" };
    }
    if (
      options2.origins !== undefined &&
      joined.origin !== undefined &&
      !options2.origins.some((rule: ObjectOrigin) =>
        rule.host === joined.origin?.host && rule.kind === joined.origin?.kind
      )
    ) {
      return { kind: "deny", reason: "ORIGIN_FORBIDDEN" };
    }
    return decideAdmission(
      {
        ...joined,
        resource: contract.name,
        action: context.action ?? "get",
      },
      options2.admission as AdmissionPolicy | undefined
    );
  }

  async function waitGate(instance: Instance, timeoutMs: number): Promise<void> {
    const gate = instance.gate;
    if (gate === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ObjectTimeoutError()), timeoutMs);
    });
    try {
      await Promise.race([gate, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function acquire<T>(
    contract: Contract<any, any>,
    params: unknown = undefined,
    context: AdmissionContext = {}
  ): Promise<Reference<T>> {
    assertContract(contract);
    if (closed) {
      return bind(synthetic<T>("ended", contract, 0, { reason: "HOST_CLOSED" }), "get");
    }
    const decision = route(contract, context);
    if (decision.kind === "deny") {
      // admission 拒绝：不创建 instance、不调用 factory、不保留任何值。
      emit({
        kind: "admission",
        contract: contract.name,
        errorClass: "ADMISSION",
        detail: decision.reason,
        ...(context.principal === undefined ? {} : { principal: context.principal.userId }),
      });
      return bind(synthetic<T>("denied", contract, 0, {
        reason: decision.reason,
        error: new AdmissionError(decision.reason, decision.detail),
      }), "get");
    }

    const key = stableKey(contract, params);
    let instance = instances.get(key);
    if (instance === undefined) {
      const provider = providers.get(contract.fingerprint)!;
      const callContext = mergeContext(baseContext(options, context.principal), context);
      instance = {
        key,
        contract,
        params,
        current: synthetic<T>("loading", contract, generationSeed + 1),
        retired: new Set(),
        gate: null,
        releaseGate: null,
      };
      instances.set(key, instance);
      const attempt = startAttempt(instance, provider, callContext, ++generationSeed);
      instance.current = attempt;
      emit({ kind: "load", contract: contract.name, generation: attempt.generation });
    } else {
      try {
        await waitGate(instance, drainMs);
      } catch (error) {
        return bind(synthetic<T>("failed", contract, instance.current.generation, {
          error,
          reason: error instanceof ObjectTimeoutError ? "TIMEOUT" : "LIFECYCLE",
        }), "get");
      }
      if (closed) return bind(synthetic<T>("ended", contract, instance.current.generation, { reason: "HOST_CLOSED" }), "get");
    }
    return bind<T>(instance.current, "get");
  }

  function serve<T>(
    contract: Contract<any, any>,
    factory: ObjectFactory<any, T>,
    options2: ServeOptions<any> = {},
    facetName = "host"
  ): void {
    assertContract(contract);
    if (typeof factory !== "function") throw new Error("INVALID_OBJECT_FACTORY");
    if (closed) throw new Error("HOST_CLOSED");
    const existing = providers.get(contract.fingerprint);
    if (existing !== undefined) throw new Error(`PROVIDER_DUPLICATE: ${contract.name}`);
    const provider: ProviderDef<T> = {
      contract,
      factory,
      options: options2,
      facetName,
      codeKey: options2.digest ?? `${facetName}:${options2.version ?? ""}:${factoryRef(factory)}`,
    };
    providers.set(contract.fingerprint, provider);
    emit({ kind: "serve", contract: contract.name });
  }

  let factorySeed = 0;
  const factoryIds = new WeakMap<object, number>();
  function factoryRef(factory: object): string {
    let id = factoryIds.get(factory);
    if (id === undefined) {
      id = ++factorySeed;
      factoryIds.set(factory, id);
    }
    return String(id);
  }

  function runSetup(facets: readonly LoadedFacet[], target: Map<string, ProviderDef<any>>): LoadReport {
    const loaded: string[] = [];
    const hostView: FacetHost<any> = {
      serve<T>(contract: Contract<any, any>, factory: ObjectFactory<any, T>, options2?: ServeOptions<any>) {
        assertContract(contract);
        if (typeof factory !== "function") throw new Error("INVALID_OBJECT_FACTORY");
        if (target.has(contract.fingerprint)) throw new Error(`PROVIDER_DUPLICATE: ${contract.name}`);
        target.set(contract.fingerprint, {
          contract,
          factory,
          options: options2 ?? {},
          facetName: "facet",
          codeKey: `${options2?.digest ?? ""}:${options2?.version ?? ""}:${factoryRef(factory)}`,
        });
        emit({ kind: "serve", contract: contract.name });
      },
      references<T>(contract: Contract<any, any>) {
        return references<T>(contract);
      },
    };
    const self: FacetSelf = {
      async get<T>(contract: Contract<any, any>, params?: unknown, context?: AdmissionContext) {
        return await acquire<T>(contract, params, context);
      },
    };
    for (const loadedFacet of facets) {
      if (typeof loadedFacet?.facet?.setup !== "function") throw new Error("INVALID_FACET");
      loadedFacet.facet.setup(hostView, self);
      loaded.push(loadedFacet.name);
    }
    return { loaded };
  }

  function references<T>(contract: Contract<any, any>): readonly Reference<T>[] {
    assertContract(contract);
    const result: Reference<T>[] = [];
    for (const instance of instances.values()) {
      if (instance.current.contract.fingerprint !== contract.fingerprint) continue;
      for (const lease of instance.current.leases) {
        if (!lease.released) result.push(lease.reference as Reference<T>);
      }
    }
    return result;
  }

  async function reload(facets?: readonly LoadedFacet[], options2: ReloadOptions = {}): Promise<ReloadReport> {
    if (closed) throw new Error("HOST_CLOSED");
    const report: ReloadReport = { restarted: [], retried: [], ended: [], parked: [], failed: [] };
    const staged = new Map<string, ProviderDef<any>>(providers);
    if (facets !== undefined) {
      staged.clear();
      runSetup(facets, staged);
    }

    for (const instance of [...instances.values()]) {
      const next = staged.get(instance.contract.fingerprint);
      const previous = instance.current;

      if (next === undefined) {
        // 代码撤销：旧 attempt 保留给在途调用，release 后回收；新调用得到 ended。
        const gate = deferredGate(instance);
        previous.retired = true;
        instance.retired.add(previous);
        maybeDispose(previous);
        setState(previous, "ended");
        instance.current = synthetic("ended", instance.contract, previous.generation, { reason: "PROVIDER_REMOVED" });
        gate.release();
        emit({ kind: "end", contract: instance.contract.name, generation: previous.generation });
        report.ended.push(instance.key);
        continue;
      }

      const unchanged = previous.provider !== undefined && previous.provider.codeKey === next.codeKey && previous.state === "live";
      if (unchanged) continue; // digest 相同复用同一对象，不重启

      const isRetry = previous.state === "failed";
      const gate = deferredGate(instance);
      previous.retired = true;
      instance.retired.add(previous);

      const attempt = startAttempt(instance, next, previous.callContext, ++generationSeed);
      await attempt.ready;
      instance.current = attempt;
      gate.release();
      if (attempt.state === "live") {
        maybeDispose(previous);
        emit({
          kind: isRetry ? "retry" : "restart",
          contract: instance.contract.name,
          generation: attempt.generation,
        });
        (isRetry ? report.retried : report.restarted).push(instance.key);
      } else if (attempt.state === "loading") {
        report.parked.push(instance.key);
      } else {
        // closure rule：新代码失败 → 保留旧代码继续服务，不把半成品值喂给新调用。
        instance.current = previous;
        previous.retired = false;
        instance.retired.delete(previous);
        report.failed.push(instance.key);
        errorEvent("reload", attempt.error, instance.contract, attempt.generation, previous.callContext.principal?.realm);
        if (previous.leases.size === 0 && previous.fiber !== undefined) maybeDispose(previous);
        // 失败的候选 attempt 没有引用方，回收其 fiber，不残留 FAILED 实例。
        if (attempt.fiber !== undefined) void attempt.fiber.remove();
      }
    }

    providers.clear();
    for (const [fingerprint, provider] of staged) providers.set(fingerprint, provider);
    void options2;
    return report;
  }

  function deferredGate(instance: Instance): { release(): void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    instance.gate = gate;
    instance.releaseGate = () => {
      release();
      if (instance.gate === gate) {
        instance.gate = null;
        instance.releaseGate = null;
      }
    };
    return { release: instance.releaseGate };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const instance of instances.values()) {
      const current = instance.current;
      current.retired = true;
      setState(current, "ended");
      if (current.fiber !== undefined) void current.fiber.remove();
      instance.releaseGate?.();
    }
    if (ownContext) await context.dispose();
  }

  return {
    serve,
    async load(facets) {
      if (closed) throw new Error("HOST_CLOSED");
      const report = runSetup(facets, providers);
      emit({ kind: "load", detail: report.loaded.join(",") });
      return report;
    },
    get: acquire,
    hold: async <T>(contract: Contract<any, any>, params?: unknown, context2?: AdmissionContext) => {
      const reference = await acquire<T>(contract, params, context2);
      emit({ kind: "hold", ...(contract === undefined ? {} : { contract: contract.name }) });
      return reference;
    },
    reload,
    references,
    route,
    telemetry,
    close,
  };
}
