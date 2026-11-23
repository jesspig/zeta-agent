import type {
  CoeffectKey,
  Component,
  Disposer,
  Effect,
  EffectCallback,
  FiberContext,
  LifecycleState,
  OperationSet,
} from "./types";
// facade 只做装配：复用 cordis 组件的 EffectHost / ReflectNode / FiberSystem，不重写核心语义。
// 使用相对路径而非包名，避免 facade -> cordis -> facade 的 workspace 依赖环。
import {
  createEffectHost,
  effect as runEffect,
  NOOP,
  type EffectHost,
} from "../../components/cordis/src/effect";
import {
  commit as reflectCommit,
  createNode,
  createProxy,
  get as reflectGet,
  intercept as reflectIntercept,
  isolate as reflectIsolate,
  set as reflectSet,
  type ReflectNode,
} from "../../components/cordis/src/reflect";
import { FiberSystem, type Fiber, type FiberSpec } from "../../components/cordis/src/fiber";

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
  readonly contributions: C[];
  readonly compose: (items: C[]) => V;
  readonly fallback: V;
}

export interface RegistryOptions<C, V> {
  readonly version?: number;
  /** 必须同步、纯净，且总有回退值。 */
  readonly compose: (items: C[]) => V;
  readonly fallback?: V;
}

export function defineRegistry<C, V>(name: string, options: RegistryOptions<C, V>): Registry<C, V> {
  return {
    name,
    version: options.version,
    contributions: [],
    compose: options.compose,
    fallback: options.fallback as V,
  };
}

/** 贡献值返回逆；重复 dispose 只生效一次。 */
export function contribute<C, V>(registry: Registry<C, V>, value: C): Disposer {
  registry.contributions.push(value);
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    const index = registry.contributions.indexOf(value);
    if (index >= 0) registry.contributions.splice(index, 1);
  };
}

export function resolveRegistry<C, V>(registry: Registry<C, V>): V {
  return registry.compose([...registry.contributions]);
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
  readonly pending: Set<Promise<unknown>>;
  readonly providers: Map<symbol, Fiber>;
  readonly listeners: Map<string, Set<(payload: unknown) => void>>;
  readonly intercepted: Map<symbol, unknown>;
  /** accepts 校验用的版本注册表：provider fiber 在 use 装配时登记其声明版本。 */
  readonly providerVersions: Map<symbol, { uid: string; version?: string }>;
  readonly uidSeed: { value: number };
  /** 派生 context（isolate/intercept/组件 fiber）不自动注册 provider fiber。 */
  readonly registerProvider: boolean;
}

function track(internals: Internals, promise: Promise<unknown>): void {
  internals.pending.add(promise);
  const forget = () => {
    internals.pending.delete(promise);
  };
  void promise.then(forget, forget);
}

function makeContext(base: Internals, node: ReflectNode = base.node, registerProvider = base.registerProvider): Context {
  const internals: Internals = { ...base, node, registerProvider };

  const effect = (callback: EffectCallback, label?: string): Disposer =>
    runEffect(internals.host, () => callback(context), label);

  const get = <T>(key: CoeffectKey<T>): T => reflectGet(internals.node, key) as T;

  /** Proxy 门禁入口：symbol 属性访问走 committed view 解析并强制声明检查。 */
  const proxy = <T extends object>(): T => createProxy<T>(internals.node);

  const set = <T>(key: CoeffectKey<T>, value: T): Disposer => reflectSet(internals.node, key, value);

  const provide = <T>(key: CoeffectKey<T>, value: T): Disposer => {
    const restore = reflectSet(internals.node, key, value);
    // G04：production 也写入 node.committed，使 ctx.get 的 committed 分支真正可达；
    // G02：check 由 provider 撤销态注入，撤销后读取抛 CAPABILITY_EXPIRED。
    let revoked = false;
    let dependents = new Set<string>();
    let fiber: Fiber | undefined;

    if (internals.registerProvider) {
      const previous = internals.providers.get(key.symbol);
      if (previous) previous.remove();
      const uid = `provider:${++internals.uidSeed.value}:${key.symbol.description ?? key.name}`;
      fiber = internals.system.create({
        uid,
        inject: [],
        provide: [key],
        apply: () => NOOP,
      });
      internals.providers.set(key.symbol, fiber);
      // G03：committed Impl.dependents 与 provider fiber 的 dependents 共享载体。
      dependents = fiber.committedDependents;
      track(internals, fiber.refresh());
    }

    reflectCommit(internals.node, key, value, key.symbol, () => !revoked, dependents);

    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      revoked = true;
      restore();
      if (fiber && internals.providers.get(key.symbol) === fiber) {
        fiber.remove();
        internals.providers.delete(key.symbol);
      }
    };
  };

  const isolate = <T>(key: CoeffectKey<T>, realm?: symbol): FiberContext =>
    makeContext(internals, reflectIsolate(internals.node, key, realm ?? Symbol(key.symbol.description ?? key.name)), false);

  const intercept = <T>(key: CoeffectKey<T>, metadata: unknown): FiberContext => {
    internals.intercepted.set(key.symbol, metadata);
    const transform: (value: unknown) => unknown =
      typeof metadata === "function" ? (metadata as (value: unknown) => unknown) : (value) => value;
    return makeContext(internals, reflectIntercept(internals.node, key, transform), false);
  };

  const use = <P>(component: Component<P>, config?: P): ContextFiber => {
    const uid = `fiber:${++internals.uidSeed.value}`;
    const fiberNode = createNode(uid, internals.node, [...component.inject, ...component.provide]);
    const fiberCtx = makeContext(internals, fiberNode, false);
    // 版本注册表在装配期登记；accepts 在 apply 时校验（此时 provider 已进入 ACTIVE）。
    for (const key of component.provide) {
      internals.providerVersions.set(key.symbol, { uid, version: component.version });
    }
    const spec: FiberSpec = {
      uid,
      inject: component.inject,
      provide: component.provide,
      config,
      // config 通过 FiberSpec 下发，Component.apply 收到的是调用方传入的配置。
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
        fiber.remove();
      },
    };
  };

  const on = (name: string, listener: (payload: unknown) => void): Disposer => {
    const bucket = internals.listeners.get(name) ?? new Set();
    bucket.add(listener);
    internals.listeners.set(name, bucket);
    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      bucket.delete(listener);
    };
  };

  const emit = (name: string, payload?: unknown): void => {
    for (const listener of [...(internals.listeners.get(name) ?? [])]) listener(payload);
  };

  const notify = async (keys?: readonly CoeffectKey<any>[]): Promise<void> => {
    // 先排空在途的 provide/use 装载，保证通知看到稳定的 provider 集合。
    await Promise.all([...internals.pending].map((promise) => promise.catch(() => undefined)));
    const wanted = keys === undefined ? null : new Set(keys.map((key) => key.symbol));
    const targets = [...internals.system.fibers.values()].filter(
      (fiber) =>
        fiber.spec.inject.length > 0 &&
        (wanted === null || fiber.spec.inject.some((key) => wanted.has(key.symbol)))
    );
    await Promise.all(targets.map((fiber) => fiber.refresh()));
  };

  const dispose: Disposer = async () => {
    for (const fiber of [...internals.system.fibers.values()]) fiber.remove();
    internals.providers.clear();
    internals.listeners.clear();
    internals.pending.clear();
    await internals.host.dispose();
  };

  const context: Context = {
    uid: internals.host.uid,
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
export function createContext(options: { uid?: string } = {}): Context {
  const uid = options.uid ?? `ctx:${++contextSeed}`;
  return makeContext({
    host: createEffectHost(uid),
    node: createNode(uid, null, []),
    system: new FiberSystem(),
    pending: new Set(),
    providers: new Map(),
    listeners: new Map(),
    intercepted: new Map(),
    providerVersions: new Map(),
    uidSeed: { value: 0 },
    registerProvider: true,
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

