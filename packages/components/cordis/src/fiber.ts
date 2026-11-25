import type {
  CoeffectKey,
  Disposer,
  Effect,
  EffectObserver,
  Impl,
  LifecycleState,
  ProvideOptions,
  View,
} from "./types";
import { createEffectHost, effect, execute, NOOP, toIterator, unloadHost, type EffectHost } from "./effect";

export const PROVIDER_DUPLICATE = "PROVIDER_DUPLICATE";

/** guard 等待 consumer 去活的默认有界超时；超时记诊断并继续 teardown，绝不强等。 */
export const DEFAULT_GUARD_TIMEOUT_MS = 200;

export interface FiberSystemOptions {
  readonly observer?: EffectObserver;
  /** 可配置的 guard 超时（毫秒），用于撤回等待与刷新门的有界诊断。 */
  readonly guardTimeoutMs?: number;
}

export interface GuardTimeoutDiagnostic {
  readonly uid: string;
  readonly waitedMs: number;
  readonly dependents: readonly string[];
}

export function key<T = unknown>(name: string): CoeffectKey<T> {
  return { namespace: "@zeta-agent/testing", name, symbol: Symbol(name) } as CoeffectKey<T>;
}

export interface FiberSpec {
  readonly uid: string;
  readonly inject: readonly CoeffectKey<any>[];
  readonly provide: readonly CoeffectKey<any>[];
  readonly config?: unknown;
  readonly realm?: symbol;
  readonly parent?: Fiber;
  readonly values?: ReadonlyMap<symbol, unknown>;
  readonly checks?: ReadonlyMap<symbol, () => boolean>;
  readonly autoProvide?: boolean;
  /** 兼容旧调用方 apply(ctx)；新调用方可声明 apply(ctx, config)。 */
  readonly apply?: (ctx: EffectHost, config?: unknown) => Effect | Promise<Effect>;
}

export interface ProviderBinding {
  readonly key: CoeffectKey<any>;
  readonly realm: symbol;
  readonly provider: Fiber;
  readonly impl: Impl;
  readonly rootImpl: Impl;
  available: boolean;
  released: boolean;
}

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error];
}

function sameView(left: View | null, right: View | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.size !== right.size) return false;
  for (const [name, impl] of left) {
    if (right.get(name) !== impl) return false;
  }
  return true;
}

export class FiberSystem {
  readonly fibers = new Map<string, Fiber>();
  readonly defaultRealm = Symbol("cordis:default-realm");
  private readonly bindings = new Map<symbol, Map<symbol, ProviderBinding>>();
  private readonly latestBindings = new Map<symbol, Map<symbol, ProviderBinding>>();
  private readonly revisions = new Map<symbol, Map<symbol, number>>();
  private readonly subscribers = new Map<symbol, Map<symbol, Set<Fiber>>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  readonly diagnostics: GuardTimeoutDiagnostic[] = [];
  readonly guardTimeoutMs: number;

  constructor(readonly observer?: EffectObserver, options: FiberSystemOptions = {}) {
    this.guardTimeoutMs = options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
  }

  /** guard 有界超时：记录结构化诊断并显式记错，交由 drain 汇总上报。 */
  recordGuardTimeout(diagnostic: GuardTimeoutDiagnostic, error: Error): void {
    this.diagnostics.push(diagnostic);
    this.failures.push(error);
  }

  create(spec: FiberSpec): Fiber {
    const fiber = new Fiber(this, spec);
    this.fibers.set(spec.uid, fiber);
    this.subscribe(fiber);
    return fiber;
  }

  claim(
    key: CoeffectKey<any>,
    realm: symbol,
    value: unknown,
    provider: Fiber,
    check?: () => boolean,
    consult?: (metadata: unknown) => boolean
  ): ProviderBinding {
    const realmBindings = this.bindings.get(realm) ?? new Map<symbol, ProviderBinding>();
    const previous = realmBindings.get(key.symbol);
    if (previous && !previous.released) {
      throw new Error(`${PROVIDER_DUPLICATE}: ${key.symbol.description ?? key.name}@${realm.toString()}`);
    }
    const binding = {} as ProviderBinding;
    const realmRevisions = this.revisions.get(realm) ?? new Map<symbol, number>();
    const generation = (realmRevisions.get(key.symbol) ?? 0) + 1;
    realmRevisions.set(key.symbol, generation);
    this.revisions.set(realm, realmRevisions);
    const impl: Impl = {
      uid: provider.uid,
      value,
      dependents: provider.committedDependents,
      isolate: realm,
      generation,
      check: () => binding.available && (check?.() ?? true),
      ...(consult ? { consult } : {}),
    };
    const rootImpl: Impl = {
      ...impl,
      check: () =>
        !binding.released &&
        (provider.state.kind === "ACTIVE" || provider.state.kind === "LOADING") &&
        (check?.() ?? true),
    };
    Object.assign(binding, { key, realm, provider, impl, rootImpl, available: true, released: false });
    realmBindings.set(key.symbol, binding);
    this.bindings.set(realm, realmBindings);
    const latest = this.latestBindings.get(realm) ?? new Map<symbol, ProviderBinding>();
    latest.set(key.symbol, binding);
    this.latestBindings.set(realm, latest);
    if (provider.state.kind !== "LOADING") this.notify([key], realm);
    return binding;
  }

  release(binding: ProviderBinding): void {
    if (binding.released) return;
    binding.released = true;
    const realmBindings = this.bindings.get(binding.realm);
    if (realmBindings?.get(binding.key.symbol) === binding) realmBindings.delete(binding.key.symbol);
    if (binding.provider.state.kind !== "LOADING" && !binding.provider.updating) {
      this.notify([binding.key], binding.realm);
    }
  }

  committedFor(key: CoeffectKey<any>, realm: symbol): Impl | undefined {
    return this.latestBindings.get(realm)?.get(key.symbol)?.rootImpl;
  }

  /** 可观察的按 realm/键绑定序号；同值重新 provide 也会递增。 */
  revisionOf(key: CoeffectKey<any>, realm: symbol): number {
    return this.revisions.get(realm)?.get(key.symbol) ?? 0;
  }

  forget(key: CoeffectKey<any>, realm: symbol): void {
    this.latestBindings.get(realm)?.delete(key.symbol);
  }

  /**
   * 回收一个 realm 的 provider/订阅登记。fiber 的卸载由 fiber.remove 负责，
   * 这里只清掉 realm 索引，使 realm churn 不残留可解析的 binding。
   */
  disposeRealm(realm: symbol): void {
    this.bindings.delete(realm);
    this.latestBindings.delete(realm);
    this.revisions.delete(realm);
    this.subscribers.delete(realm);
  }

  activeBinding(key: CoeffectKey<any>, realm: symbol): ProviderBinding | undefined {
    const binding = this.bindings.get(realm)?.get(key.symbol);
    if (!binding || binding.released || binding.provider.state.kind !== "ACTIVE") return undefined;
    if (binding.impl.check && !binding.impl.check()) return undefined;
    return binding;
  }

  bindingForImpl(key: CoeffectKey<any>, realm: symbol, impl: Impl): ProviderBinding | undefined {
    const active = this.bindings.get(realm)?.get(key.symbol);
    if (active?.impl === impl) return active;
    const latest = this.latestBindings.get(realm)?.get(key.symbol);
    return latest?.impl === impl ? latest : undefined;
  }

  viewFor(names: readonly CoeffectKey<any>[], realm = this.defaultRealm, exceptUid = ""): View | null {
    const view: View = new Map();
    for (const name of names) {
      const binding = this.activeBinding(name, realm);
      if (!binding || binding.provider.uid === exceptUid) return null;
      view.set(name, binding.impl);
    }
    return view;
  }

  providerOf(name: CoeffectKey<any>, exceptUid: string, realm = this.defaultRealm): Fiber | undefined {
    const provider = this.activeBinding(name, realm)?.provider;
    return provider?.uid === exceptUid ? undefined : provider;
  }

  notify(keys?: readonly CoeffectKey<any>[], realm?: symbol): void {
    const wanted = keys === undefined ? undefined : new Set(keys.map((item) => item.symbol));
    for (const [subscriberRealm, byKey] of this.subscribers) {
      if (realm !== undefined && subscriberRealm !== realm) continue;
      const targets = new Set<Fiber>();
      for (const [symbol, fibers] of byKey) {
        if (wanted && !wanted.has(symbol)) continue;
        for (const fiber of fibers) targets.add(fiber);
      }
      for (const fiber of targets) this.track(fiber.refresh());
    }
  }

  track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      (error) => {
        this.pending.delete(promise);
        this.failures.push(error);
      }
    );
  }

  async drain(timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const unsettled = [...this.fibers.values()]
          .filter((fiber) => fiber.state.kind === "LOADING" || fiber.state.kind === "UNLOADING")
          .map((fiber) => `${fiber.uid}:${fiber.state.kind}`)
          .join(",");
        reject(new Error(`FIBER_DRAIN_TIMEOUT: ${unsettled || "unknown pending transition"}`));
      }, timeoutMs);
    });
    try {
      while (this.pending.size > 0) {
        if (Date.now() >= deadline) throw new Error(`FIBER_DRAIN_TIMEOUT: ${[...this.fibers.keys()].join(",")}`);
        await Promise.race([
          Promise.all([...this.pending].map((promise) => promise.catch(() => undefined))),
          timeout,
        ]);
      }
      if (this.failures.length > 0) {
        const failures = this.failures.splice(0);
        throw new AggregateError(failures, "fiber transition teardown 失败");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private subscribe(fiber: Fiber): void {
    const byKey = this.subscribers.get(fiber.realm) ?? new Map<symbol, Set<Fiber>>();
    for (const key of fiber.spec.inject) {
      const fibers = byKey.get(key.symbol) ?? new Set<Fiber>();
      fibers.add(fiber);
      byKey.set(key.symbol, fibers);
    }
    this.subscribers.set(fiber.realm, byKey);
  }

  unsubscribe(fiber: Fiber): void {
    const byKey = this.subscribers.get(fiber.realm);
    if (!byKey) return;
    for (const fibers of byKey.values()) fibers.delete(fiber);
    if ([...byKey.values()].every((fibers) => fibers.size === 0)) this.subscribers.delete(fiber.realm);
  }
}

export class Fiber {
  state: LifecycleState = { kind: "PENDING" };
  target: View | null = null;
  inertia: Promise<void> | null = null;
  readonly dependents = new Set<Fiber>();
  readonly committedDependents = new Set<string>();
  readonly host: EffectHost;
  readonly realm: symbol;
  readonly children = new Set<Fiber>();
  private readonly provided = new Map<symbol, ProviderBinding>();
  private readonly retiredBindings = new Set<ProviderBinding>();
  private readonly dependencies = new Map<symbol, ProviderBinding>();
  private loaded = false;
  updating = false;
  private removeRequested = false;
  private removing: Promise<void> | null = null;

  get uid(): string {
    return this.spec.uid;
  }

  constructor(readonly system: FiberSystem, readonly spec: FiberSpec) {
    this.realm = spec.realm ?? system.defaultRealm;
    this.host = createEffectHost(spec.uid, this.system.observer);
    this.host.effect = (callback, label) => effect(this.host, callback, label);
    if (spec.parent) {
      spec.parent.children.add(this);
      // 子 fiber 的退役登记在父 effect/host 上：父 update/依赖撤回时 unloadHost 会
      // 执行它，旧子 fiber 逆各一次；父重新 apply 时按新 uid 创建新子 fiber 并重新登记。
      (spec.parent.host.effects as Disposer[]).push(() => this.remove());
    }
    if (spec.autoProvide ?? true) {
      for (const key of spec.provide) {
        this.provide(key, spec.values?.get(key.symbol) ?? key.name, {
          check: spec.checks?.get(key.symbol),
        });
      }
    }
  }

  provide<T>(key: CoeffectKey<T>, value: T, options: ProvideOptions = {}): Disposer {
    const previous = this.provided.get(key.symbol);
    if (previous) this.releaseBinding(previous);
    const binding = this.system.claim(key, this.realm, value, this, options.check, options.consult);
    this.provided.set(key.symbol, binding);
    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      if (this.provided.get(key.symbol) === binding) this.provided.delete(key.symbol);
      this.releaseBinding(binding);
      this.finalizeRetiredBindings();
    };
  }

  async refresh(): Promise<void> {
    if (this.removeRequested || this.state.kind === "DISPOSED" || this.state.kind === "FAILED") return;
    const prior = this.inertia;
    if (prior) {
      await prior;
      if (this.inertia === prior) this.inertia = null;
    }
    if (this.removeRequested || this.isDisposed() || this.isFailed()) return;
    const target = this.system.viewFor(this.spec.inject, this.realm, this.uid);
    if (sameView(target, this.target)) return;
    this.target = target;
    const previous = this.state;
    const committed = "committed" in previous ? previous.committed : target ?? new Map();
    if (target === null) {
      this.state = {
        kind: "UNLOADING",
        dispose: "dispose" in previous ? previous.dispose : NOOP,
        committed,
      };
      this.inertia = this.unload();
    } else if (previous.kind === "ACTIVE") {
      // 非空 target 替换：先执行旧逆，再由 unload 尾部的 target 触发新 apply。
      this.state = {
        kind: "UNLOADING",
        dispose: "dispose" in previous ? previous.dispose : NOOP,
        committed,
      };
      this.inertia = this.unload();
    } else {
      this.state = { kind: "LOADING", iter: toIterator(NOOP), dispose: NOOP, committed };
      this.inertia = this.reload(target);
    }
    const running = this.inertia;
    this.system.track(running);
    await running;
    if (this.inertia === running) this.inertia = null;
  }

  async update(): Promise<void> {
    if (this.removeRequested || this.state.kind === "DISPOSED") return;
    if (this.inertia) await this.inertia;
    if (this.removeRequested || this.isDisposed()) return;
    this.updating = true;
    try {
      if (this.state.kind === "FAILED") this.state = { kind: "PENDING" };
      if ("committed" in this.state) {
        const previous = this.state;
        this.target = null;
        this.state = { ...previous, kind: "UNLOADING" };
        await this.unload();
      }
      this.target = null;
      await this.refresh();
    } finally {
      this.updating = false;
      this.inertia = null;
    }
  }

  remove(): Promise<void> {
    if (this.state.kind === "DISPOSED") return Promise.resolve();
    if (this.removing) return this.removing;
    this.removeRequested = true;
    this.target = null;
    const childRemovals = [...this.children].map((child) => child.remove());
    const running = this.inertia;
    this.removing = (async () => {
      if (running) await running.catch(() => undefined);
      if (!this.isDisposed() && this.state.kind !== "PENDING" && this.state.kind !== "FAILED") {
        const previous = this.state;
        this.state = {
          kind: "UNLOADING",
          dispose: "dispose" in previous ? previous.dispose : NOOP,
          committed: "committed" in previous ? previous.committed : new Map(),
        };
        await this.unload();
      } else if (!this.isDisposed()) {
        this.releaseProvided();
        this.clearDependencies();
        this.finalizeDisposed();
      }
      const results = await Promise.allSettled(childRemovals);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "child fiber teardown 失败");
      this.inertia = null;
    })();
    this.system.track(this.removing);
    return this.removing;
  }

  private async reload(target: View): Promise<void> {
    try {
      if (this.loaded) this.releaseProvided();
      const source: Effect = await (this.spec.apply ? this.spec.apply(this.host, this.spec.config) : NOOP);
      const dispose: Disposer = await execute(source, () => this.target === target && !this.removeRequested);
      if (this.target === target && !this.removeRequested) {
        this.commitDependencies(target);
        this.loaded = true;
        this.state = { kind: "ACTIVE", dispose, committed: target };
        // 旧 committed view 已切换，回收此刻已无人引用的 retired binding。
        for (const binding of this.dependencies.values()) binding.provider.finalizeRetiredBindings();
        this.system.notify(this.spec.provide, this.realm);
      } else {
        const previous = this.state;
        this.state = {
          kind: "UNLOADING",
          dispose,
          committed: "committed" in previous ? previous.committed : target,
        };
        this.inertia = this.unload();
        await this.inertia;
      }
    } catch (error) {
      this.releaseProvided();
      const cleanup = await Promise.allSettled([unloadHost(this.host)]);
      const cleanupErrors = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .flatMap((result) => flattenErrors(result.reason));
      this.clearDependencies();
      for (const binding of this.retiredBindings) binding.available = false;
      this.retiredBindings.clear();
      this.loaded = false;
      this.state = {
        kind: "FAILED",
        error: cleanupErrors.length > 0 ? new AggregateError([error, ...cleanupErrors], "fiber load 失败") : error,
      };
    }
  }

  private async unload(): Promise<void> {
    // 保留旧 committed view：非空 target 替换时 unload 尾部的 reload 读取的仍是旧值，
    // 直到新 effect 成功提交后才切换，避免 teardown/apply 中途看到半更新状态。
    const previousCommitted: View = "committed" in this.state ? this.state.committed : new Map();
    this.releaseProvided();
    const deadline = Date.now() + this.system.guardTimeoutMs;
    while (true) {
      const activeDependents = [...this.dependents].filter((fiber) =>
        "committed" in fiber.state &&
        [...fiber.state.committed.values()].some((impl) =>
          [...this.retiredBindings].some((binding) => binding.impl === impl)
        )
      );
      if (activeDependents.length === 0) break;
      if (Date.now() >= deadline) {
        // 有界超时：显式记错并继续 teardown，不再无限轮询；consumer 会在下一次
        // target 变化时通过 claim 通知收到撤回，不会永久悬挂。
        this.system.recordGuardTimeout(
          {
            uid: this.uid,
            waitedMs: this.system.guardTimeoutMs,
            dependents: activeDependents.map((fiber) => fiber.uid),
          },
          new Error(
            `FIBER_GUARD_TIMEOUT: ${this.uid} 等待 ${activeDependents.map((fiber) => fiber.uid).join(",")} 去活超过 ${this.system.guardTimeoutMs}ms`
          )
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const errors: unknown[] = [];
    if (this.state.kind === "UNLOADING") {
      const results = await Promise.allSettled([this.state.dispose(), unloadHost(this.host)]);
      errors.push(
        ...results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .flatMap((result) => flattenErrors(result.reason))
      );
    }
    this.clearDependencies();
    if (!this.updating) {
      for (const binding of this.retiredBindings) binding.available = false;
      this.retiredBindings.clear();
    }
    this.loaded = false;
    this.finalizeRetiredBindings();
    if (this.removeRequested) {
      this.finalizeDisposed();
    } else {
      this.state = { kind: "PENDING" };
      if (this.target !== null) {
        const next = this.target;
        this.state = { kind: "LOADING", iter: toIterator(NOOP), dispose: NOOP, committed: previousCommitted };
        this.inertia = this.reload(next);
        await this.inertia;
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "fiber unload teardown 失败");
  }

  private commitDependencies(target: View): void {
    this.clearDependencies();
    for (const [key, impl] of target) {
      const binding = this.system.bindingForImpl(key, this.realm, impl);
      if (!binding) continue;
      this.dependencies.set(key.symbol, binding);
      binding.provider.dependents.add(this);
      binding.provider.committedDependents.add(this.uid);
    }
  }

  private clearDependencies(): void {
    for (const binding of this.dependencies.values()) {
      binding.provider.dependents.delete(this);
      binding.provider.committedDependents.delete(this.uid);
      binding.provider.finalizeRetiredBindings();
    }
    this.dependencies.clear();
  }

  private releaseProvided(): void {
    for (const binding of [...this.provided.values()]) this.releaseBinding(binding);
    this.provided.clear();
  }

  private releaseBinding(binding: ProviderBinding): void {
    if (binding.released) return;
    this.system.release(binding);
    this.retiredBindings.add(binding);
  }

  private finalizeRetiredBindings(): void {
    for (const binding of this.retiredBindings) {
      if (binding.provider.dependents.size > 0) continue;
      // 仍有 fiber 在 committed view 中引用该 impl（在途 reload 需读旧值）时保持可用。
      const stillCommitted = [...this.system.fibers.values()].some(
        (fiber) =>
          "committed" in fiber.state &&
          [...fiber.state.committed.values()].some((impl) => impl === binding.impl)
      );
      if (stillCommitted) continue;
      binding.available = false;
      this.retiredBindings.delete(binding);
    }
  }

  private isDisposed(): boolean {
    return this.state.kind === "DISPOSED";
  }

  private isFailed(): boolean {
    return this.state.kind === "FAILED";
  }

  private finalizeDisposed(): void {
    this.releaseProvided();
    this.clearDependencies();
    for (const binding of this.retiredBindings) binding.available = false;
    this.retiredBindings.clear();
    this.loaded = false;
    this.system.unsubscribe(this);
    this.spec.parent?.children.delete(this);
    if (this.system.fibers.get(this.uid) === this) this.system.fibers.delete(this.uid);
    this.state = { kind: "DISPOSED" };
  }
}
