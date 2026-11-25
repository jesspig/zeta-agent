import type {
  CoeffectKey,
  Component,
  Disposer,
  Effect,
  EffectCallback,
  FiberContext,
  LifecycleState,
  OperationSet,
  ProvideOptions,
  EffectObserver,
} from "./types";
// facade 只做装配：核心语义与类型归 cordis，公开 API 由本包重导出。
import {
  createEffectHost,
  effect as runEffect,
  NOOP,
  type EffectHost,
} from "@zeta-agent/cordis/effect";
import {
  bindFiber,
  bindRealm,
  bindResolver,
  createNode,
  createProxy,
  get as reflectGet,
  intercept as reflectIntercept,
  isolate as reflectIsolate,
  set as reflectSet,
  INACTIVE_ACCESS,
  ISOLATE,
  type ReflectNode,
} from "@zeta-agent/cordis/reflect";
import { FiberSystem, type Fiber, type FiberSpec } from "@zeta-agent/cordis/fiber";

/** defineKey 的可选元数据（operations 为观察等价所需操作，commutative 为 provider 的义务）。 */
export interface KeyOptions<T> {
  readonly operations?: OperationSet<T>;
  readonly commutative?: boolean;
}

/**
 * 生成 `@scope/name:key` 形式的 coeffect 键。
 * `defineKey("@zeta-agent/tools", "registry")` 与 `defineKey("@zeta-agent/tools:registry")`
 * 均得到 symbol 描述 `@zeta-agent/tools:registry`。
 */
export function defineKey<T = unknown>(namespace: string, name?: string, opts?: KeyOptions<T>): CoeffectKey<T>;
export function defineKey<T = unknown>(qualifiedName: string, opts?: KeyOptions<T>): CoeffectKey<T>;
export function defineKey<T = unknown>(
  namespace: string,
  nameOrOpts?: string | KeyOptions<T>,
  opts: KeyOptions<T> = {}
): CoeffectKey<T> {
  let name: string | undefined;
  let options: KeyOptions<T> = opts;
  if (typeof nameOrOpts === "object" && nameOrOpts !== null) {
    options = nameOrOpts;
  } else {
    name = nameOrOpts;
  }

  let ns = namespace;
  if (name === undefined) {
    const colon = ns.lastIndexOf(":");
    if (colon > 0) {
      name = ns.slice(colon + 1);
      ns = ns.slice(0, colon);
    } else {
      name = "";
    }
  }
  if (!ns.startsWith("@")) ns = `@${ns}`;
  const cleanName = name.replace(/^:+|:+$/g, "");
  const description = cleanName.length > 0 ? `${ns}:${cleanName}` : ns;

  return {
    namespace: ns,
    name: cleanName,
    symbol: Symbol(description),
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.commutative === true ? { commutative: true } : {}),
  };
}

/** accepts 版本不匹配：fiber 进入 FAILED，不把错版本数据喂给消费者。 */
export const VERSION_MISMATCH = "VERSION_MISMATCH";

/** 已 disposed 的 context 再访问变更入口时的显式拒绝（不做 silent no-op）。 */
export const CONTEXT_DISPOSED = "CONTEXT_DISPOSED";

/** accepts 的键支持完整键描述（@scope:name）与短键名两种写法。 */
function acceptedVersion(accepts: Record<string, string>, key: CoeffectKey<any>): string | undefined {
  return accepts[key.symbol.description ?? key.name] ?? accepts[key.name];
}

export interface ComponentSpec<
  P,
  D extends CoeffectKey<any>[] = CoeffectKey<any>[],
  R extends CoeffectKey<any>[] = CoeffectKey<any>[]
> {
  readonly name: string;
  readonly version?: string;
  readonly inject?: D;
  readonly provide?: R;
  readonly accepts?: Record<string, string>;
  readonly apply: (ctx: FiberContext, config: P) => Effect | Promise<Effect>;
}

/** 声明式组件工厂：inject/provide 只做规格声明，apply 只产出 effect。 */
export function defineComponent<
  P = unknown,
  D extends CoeffectKey<any>[] = CoeffectKey<any>[],
  R extends CoeffectKey<any>[] = CoeffectKey<any>[]
>(spec: ComponentSpec<P, D, R>): Component<P, D, R> {
  return {
    name: spec.name,
    version: spec.version,
    inject: (spec.inject ?? []) as D,
    provide: (spec.provide ?? []) as R,
    ...(spec.accepts === undefined ? {} : { accepts: spec.accepts }),
    apply: (ctx, config) => spec.apply(ctx, config),
  };
}

export interface Registry<C, V> {
  readonly name: string;
  readonly version?: number;
  /** 贡献归属的 realm；不同 realm 的 registry 身份独立。 */
  readonly realm?: symbol;
  readonly contributions: C[];
  readonly compose: (items: C[]) => V;
  readonly fallback: V;
  /** compose 与 watcher 的失败被隔离在此，不向调用方抛出。 */
  readonly errors: readonly unknown[];
  watch(listener: (registry: Registry<C, V>) => void): Disposer;
}

export interface RegistryOptions<C, V> {
  readonly version?: number;
  readonly realm?: symbol;
  /** 必须同步、纯净，且总有回退值。 */
  readonly compose: (items: C[]) => V;
  readonly fallback?: V;
  /** 提供时按 compare 稳定排序；缺省保持注册顺序。 */
  readonly compare?: (left: C, right: C) => number;
}

const registryWatchers = new WeakMap<Registry<any, any>, Set<(registry: any) => void>>();
const registryComparators = new WeakMap<Registry<any, any>, ((left: any, right: any) => number) | undefined>();

function notifyWatchers<C, V>(registry: Registry<C, V>): void {
  for (const watcher of [...(registryWatchers.get(registry) ?? [])]) {
    try {
      watcher(registry);
    } catch (error) {
      (registry.errors as unknown[]).push(error);
    }
  }
}

export function defineRegistry<C, V>(name: string, options: RegistryOptions<C, V>): Registry<C, V> {
  const errors: unknown[] = [];
  const registry: Registry<C, V> = {
    name,
    version: options.version,
    realm: options.realm,
    contributions: [],
    compose: options.compose,
    fallback: options.fallback as V,
    errors,
    watch(listener) {
      const watchers = registryWatchers.get(registry) ?? new Set();
      watchers.add(listener);
      registryWatchers.set(registry, watchers);
      return () => {
        watchers.delete(listener);
      };
    },
  };
  registryComparators.set(registry, options.compare);
  return registry;
}

/** 贡献值返回逆；重复 dispose 只生效一次；增删都通知 watcher 且隔离其异常。 */
export function contribute<C, V>(registry: Registry<C, V>, value: C): Disposer {
  const compare = registryComparators.get(registry);
  const index = compare
    ? registry.contributions.findIndex((item) => compare(item, value) > 0)
    : -1;
  if (index >= 0) registry.contributions.splice(index, 0, value);
  else registry.contributions.push(value);
  notifyWatchers(registry);
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    const current = registry.contributions.indexOf(value);
    if (current >= 0) registry.contributions.splice(current, 1);
    notifyWatchers(registry);
  };
}

export function resolveRegistry<C, V>(registry: Registry<C, V>): V {
  try {
    return registry.compose([...registry.contributions]);
  } catch (error) {
    (registry.errors as unknown[]).push(error);
    return registry.fallback;
  }
}

/** use 返回的 fiber 句柄（不暴露 cordis 内部 Fiber 类型）。 */
export interface ContextFiber {
  readonly uid: string;
  readonly state: LifecycleState;
  /** 首次加载完成；若当时依赖未齐备，state 可能是 PENDING，随后由 notify 驱动。 */
  readonly ready: Promise<void>;
  update(): Promise<void>;
  remove(): void;
}

/** facade 统一上下文：cordis 的 effect/coeffect/fiber 语义的单一入口。 */
export interface Context extends FiberContext {
  readonly uid: string;
  /** 本 context 绑定的隔离域；派生 realm 与根/兄弟 realm 身份不同。 */
  readonly realm: symbol;
  use<P>(component: Component<P>, config?: P): ContextFiber;
  on(name: string, listener: (payload: unknown) => void): Disposer;
  emit(name: string, payload?: unknown): void;
  notify(keys?: readonly CoeffectKey<any>[]): Promise<void>;
  readonly dispose: Disposer;
  /** Proxy 门禁：symbol 属性按 committed view 解析，未声明访问抛 UNDECLARED_ACCESS。 */
  readonly proxy: <T extends object>() => T;
}

interface Internals {
  readonly host: EffectHost;
  readonly node: ReflectNode;
  readonly system: FiberSystem;
  /** 每个 context 独立持有 pending/资源/子 context，撤销子树时不误伤兄弟 realm。 */
  readonly pending: Set<Promise<unknown>>;
  readonly resources: Set<Disposer>;
  readonly children: Set<Internals>;
  readonly parent?: Internals;
  disposed: boolean;
  /** 拥有独立 realm：仅 root 与 isolate 派生为真；intercept/fiber 与父共享 realm。 */
  readonly ownsRealm: boolean;
  /** 事件监听器按 realm 分桶：事件名 → realm → 监听器集合，避免派生 context 共享监听表。 */
  readonly listeners: Map<string, Map<symbol, Set<(payload: unknown) => void>>>;
  /** 本 context 实例自己注册的 listener 逆：dispose 只回收自己，不碰父/兄弟 realm 的桶。 */
  readonly ownedListeners: Map<string, Set<Disposer>>;
  readonly intercepted: Map<symbol, unknown>;
  /** 事件隔离域：root 独占一个 realm，isolate 分配新 realm，intercept/fiber 继承父 realm。 */
  readonly realm: symbol;
  /** accepts 校验用的版本注册表：provider fiber 在 use 装配时登记其声明版本。 */
  readonly providerVersions: Map<symbol, { uid: string; version?: string }>;
  readonly uidSeed: { value: number };
  readonly observer?: EffectObserver;
  readonly owner?: Fiber;
}

function track(internals: Internals, promise: Promise<unknown>): void {
  internals.pending.add(promise);
  const forget = () => {
    internals.pending.delete(promise);
  };
  void promise.then(forget, forget);
}

async function settle(run: () => unknown | Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  try {
    return { status: "fulfilled", value: await run() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** 逆操作统一从子到父：子 realm 的 host/资源先回收，父 realm 不受兄弟撤销影响。 */
async function disposeInternals(internals: Internals): Promise<void> {
  if (internals.disposed) return;
  internals.disposed = true;
  const results: PromiseSettledResult<unknown>[] = [];

  for (const child of [...internals.children].reverse()) results.push(await settle(() => disposeInternals(child)));
  internals.children.clear();
  for (const dispose of [...internals.resources].reverse()) {
    internals.resources.delete(dispose);
    results.push(await settle(dispose));
  }

  // 只有拥有独立 realm 的 context 才回收该 realm 的 fiber；intercept 与父共享 realm，
  // 单独 dispose 它不能顺带卸掉父/兄弟的 fiber。
  const fibers = internals.ownsRealm
    ? [...internals.system.fibers.values()].filter(
        (fiber) => internals.node.parent === null || fiber.realm === internals.realm
      )
    : [];
  for (const fiber of fibers) results.push(await settle(() => fiber.remove()));
  results.push(await settle(() => internals.host.dispose()));

  // 只回收本实例注册的监听；intercept/derived 与父共享 realm，不能删父亲的桶。
  for (const offs of internals.ownedListeners.values()) {
    for (const off of [...offs]) off();
  }
  internals.ownedListeners.clear();
  if (internals.ownsRealm) internals.system.disposeRealm(internals.realm);
  internals.pending.clear();
  internals.parent?.children.delete(internals);

  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .flatMap((result) =>
      result.reason instanceof AggregateError ? result.reason.errors : [result.reason]
    );
  if (errors.length > 0) throw new AggregateError(errors, "context dispose teardown 失败");
}

function makeContext(
  base: Internals,
  node: ReflectNode = base.node,
  realm = base.realm,
  owner?: Fiber,
  attach = false,
  ownsRealm?: boolean
): Context {
  const host = owner?.host ?? (
    node === base.node && realm === base.realm
      ? base.host
      : createEffectHost(`${base.host.uid}:ctx:${++base.uidSeed.value}`, base.observer)
  );
  const internals: Internals = {
    ...base,
    host,
    node,
    realm,
    owner,
    pending: new Set(),
    resources: new Set(),
    children: new Set(),
    disposed: false,
    ownsRealm: ownsRealm ?? base.ownsRealm,
    ownedListeners: new Map(),
    ...(attach ? { parent: base } : {}),
  };
  if (attach) base.children.add(internals);

  const assertActive = (): void => {
    if (internals.disposed) throw new Error(CONTEXT_DISPOSED);
  };

  const effect = (callback: EffectCallback, label?: string): Disposer => {
    assertActive();
    return runEffect(internals.host, () => callback(context), label);
  };

  function get<T>(key: CoeffectKey<T>): T;
  function get<T>(key: CoeffectKey<T>, strict: false): T | undefined;
  function get<T>(key: CoeffectKey<T>, strict = true): T | undefined {
    if (internals.disposed) {
      if (!strict) return undefined;
      throw new Error(INACTIVE_ACCESS);
    }
    return reflectGet(internals.node, key, strict) as T | undefined;
  }

  /** Proxy 门禁入口：symbol 属性访问只按 committed view 解析并强制声明检查。 */
  const proxy = <T extends object>(): T => {
    assertActive();
    return createProxy<T>(internals.node);
  };

  /** 单一 writer：set 写 realm store 并精确恢复旧值；provide 走 committed provider，保留 tombstone。 */
  const write = <T>(
    key: CoeffectKey<T>,
    value: T,
    options: ProvideOptions | undefined,
    mode: "set" | "provide"
  ): Disposer => {
    assertActive();
    for (let cursor: ReflectNode | null = internals.node; cursor; cursor = cursor.parent) {
      cursor.keys.set(key.symbol, key);
      if (cursor[ISOLATE].has(key.symbol)) break;
    }
    if (mode === "set") {
      const restore = reflectSet(internals.node, key, value);
      const announce = (): void => internals.system.notify([key], realm);
      announce();
      let armed = true;
      const dispose: Disposer = () => {
        if (!armed) return;
        armed = false;
        internals.resources.delete(dispose);
        restore();
        announce();
      };
      internals.resources.add(dispose);
      return dispose;
    }
    // provider fiber 内部调用 provide 走持有者身份，避免同一 fiber 重复 claim。
    if (internals.owner) return internals.owner.provide(key, value, options);
    const uid = `provider:${++internals.uidSeed.value}:${key.symbol.description ?? key.name}`;
    const fiber = internals.system.create({
      uid,
      inject: [],
      provide: [key],
      realm,
      autoProvide: false,
      apply: () => NOOP,
    });
    const releaseValue = fiber.provide(key, value, options);
    const ready = fiber.refresh();
    track(internals, ready);
    let armed = true;
    const dispose: Disposer = () => {
      if (!armed) return;
      armed = false;
      internals.resources.delete(dispose);
      releaseValue();
      void fiber.remove();
      // provide 保留 tombstone：撤销后 root/proxy 读到 CAPABILITY_EXPIRED。
    };
    internals.resources.add(dispose);
    return dispose;
  };

  const provide = <T>(key: CoeffectKey<T>, value: T, options?: ProvideOptions): Disposer =>
    write(key, value, options, "provide");

  const set = <T>(key: CoeffectKey<T>, value: T): Disposer => write(key, value, undefined, "set");

  const isolate = <T>(key: CoeffectKey<T>, realm?: symbol): FiberContext => {
    assertActive();
    const nextRealm = realm ?? Symbol(key.symbol.description ?? key.name);
    return makeContext(internals, reflectIsolate(internals.node, key, nextRealm), nextRealm, undefined, true, true);
  };

  const intercept = <T>(key: CoeffectKey<T>, metadata: unknown): FiberContext => {
    assertActive();
    internals.intercepted.set(key.symbol, metadata);
    return makeContext(internals, reflectIntercept(internals.node, key, metadata), realm, undefined, true, false);
  };

  const use = <P>(component: Component<P>, config?: P): ContextFiber => {
    assertActive();
    const uid = `fiber:${++internals.uidSeed.value}`;
    const fiberNode = createNode(uid, internals.node, [...component.inject, ...component.provide]);
    bindRealm(fiberNode, realm);
    for (const key of component.provide) {
      internals.providerVersions.set(key.symbol, { uid, version: component.version });
    }
    const spec: FiberSpec = {
      uid,
      inject: component.inject,
      provide: component.provide,
      config,
      realm,
      parent: internals.owner,
      autoProvide: false,
      apply: (_host, appliedConfig) => {
        if (component.accepts !== undefined) {
          for (const key of component.inject) {
            const expected = acceptedVersion(component.accepts, key);
            if (expected === undefined) continue;
            const provider = internals.providerVersions.get(key.symbol);
            if (provider?.version !== expected) {
              const id = key.symbol.description ?? key.name;
              throw new Error(
                `${VERSION_MISMATCH}: ${component.name} accepts ${id}@${expected}, provider=${provider?.version ?? "<unversioned>"}`
              );
            }
          }
        }
        return component.apply(fiberCtx, appliedConfig as P);
      },
    };
    const fiber = internals.system.create(spec);
    bindFiber(fiberNode, fiber);
    const fiberCtx = makeContext(internals, fiberNode, realm, fiber);
    const ready = fiber.refresh();
    track(internals, ready);
    return {
      uid,
      get state() {
        return fiber.state;
      },
      ready,
      update: () => fiber.update(),
      remove: () => {
        for (const key of component.provide) {
          if (internals.providerVersions.get(key.symbol)?.uid === uid) {
            internals.providerVersions.delete(key.symbol);
          }
        }
        void fiber.remove();
      },
    };
  };

  const on = (name: string, listener: (payload: unknown) => void): Disposer => {
    assertActive();
    const realms = internals.listeners.get(name) ?? new Map<symbol, Set<(payload: unknown) => void>>();
    const bucket = realms.get(internals.realm) ?? new Set<(payload: unknown) => void>();
    bucket.add(listener);
    realms.set(internals.realm, bucket);
    internals.listeners.set(name, realms);
    let armed = true;
    const off: Disposer = () => {
      if (!armed) return;
      armed = false;
      bucket.delete(listener);
      internals.ownedListeners.get(name)?.delete(off);
    };
    const owned = internals.ownedListeners.get(name) ?? new Set<Disposer>();
    owned.add(off);
    internals.ownedListeners.set(name, owned);
    return off;
  };

  const emit = (name: string, payload?: unknown): void => {
    // 已 disposed 的 context 不再派发事件，但不抛错：emit 是发射而非变更入口。
    if (internals.disposed) return;
    const bucket = internals.listeners.get(name)?.get(internals.realm);
    for (const listener of [...(bucket ?? [])]) listener(payload);
  };

  const notify = async (keys?: readonly CoeffectKey<any>[]): Promise<void> => {
    assertActive();
    await Promise.all([...internals.pending].map((promise) => promise.catch(() => undefined)));
    internals.system.notify(keys, keys === undefined || internals.node.parent === null ? undefined : realm);
    await internals.system.drain();
  };

  const dispose: Disposer = () => disposeInternals(internals);

  const context: Context = {
    uid: internals.host.uid,
    realm,
    effect,
    get,
    set,
    isolate,
    intercept,
    provide,
    use,
    on,
    emit,
    notify,
    dispose,
    proxy,
  };
  return context;
}

let contextSeed = 0;

/** 创建一个可装配的运行时上下文（facade 唯一入口）。 */
export function createContext(
  options: { uid?: string; observer?: EffectObserver; realm?: symbol } = {}
): Context {
  const uid = options.uid ?? `ctx:${++contextSeed}`;
  // 外部身份系统（principal resolver）可绑定稳定 realm；缺省仍按 uid 生成。
  const realm = options.realm ?? Symbol(`realm:${uid}`);
  const node = createNode(uid, null, []);
  const system = new FiberSystem(options.observer);
  bindRealm(node, realm);
  bindResolver(node, (key, requestedRealm) => system.committedFor(key, requestedRealm));
  return makeContext({
    host: createEffectHost(uid, options.observer),
    node,
    system,
    pending: new Set(),
    resources: new Set(),
    children: new Set(),
    disposed: false,
    ownsRealm: true,
    listeners: new Map(),
    ownedListeners: new Map(),
    intercepted: new Map(),
    realm,
    providerVersions: new Map(),
    uidSeed: { value: 0 },
    ...(options.observer ? { observer: options.observer } : {}),
  });
}

/** 可导入的函数式入口：notify(ctx, keys) 等价于 ctx.notify(keys)。 */
export function notify(ctx: Context, keys?: readonly CoeffectKey<any>[]): Promise<void> {
  return ctx.notify(keys);
}

/** 可导入的 Proxy 门禁入口：createView(ctx) 等价于 ctx.proxy()。 */
export function createView<T extends object>(ctx: Context): T {
  return ctx.proxy<T>();
}

/** 可导入的函数式入口：use(ctx, component, config) 等价于 ctx.use(component, config)。 */
export function use<P>(ctx: Context, component: Component<P>, config?: P): ContextFiber {
  return ctx.use(component, config);
}

/** 可导入的函数式入口：on(ctx, name, listener) 等价于 ctx.on(name, listener)。 */
export function on(ctx: Context, name: string, listener: (payload: unknown) => void): Disposer {
  return ctx.on(name, listener);
}

