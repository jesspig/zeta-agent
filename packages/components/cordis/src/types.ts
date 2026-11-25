export type FiberId = string;

export type Disposer<T = void> = () => T | Promise<T>;

export type EffectIterator = AsyncIterable<Disposer>;

export type Effect =
  | Disposer
  | Iterable<Disposer>
  | Promise<Disposer>
  | AsyncIterable<Disposer>;

export interface OperationSet<T> {
  readonly [name: string]: (value: T) => unknown;
}

export interface CoeffectKey<T> {
  readonly namespace: string;
  readonly name: string;
  readonly symbol: symbol;
  readonly operations?: OperationSet<T>;
  readonly commutative?: boolean;
}

export interface Impl {
  uid: FiberId;
  value: unknown;
  check?(): boolean;
  dependents: Set<FiberId>;
  isolate: symbol;
  /** 每次绑定递增的可观察身份；同值重新 provide 也有不同的 generation。 */
  generation: number;
  /** provider 对 intercept 对象元数据的访问裁决；返回 false 视作能力失效。 */
  consult?(metadata: unknown): boolean;
}

export interface EffectMeta {
  readonly label: string;
  readonly runId?: string;
  readonly fiberUid?: string;
  children: EffectMeta[];
}

export interface EffectObserver {
  readonly runId?: string;
  emit(meta: EffectMeta): void;
}

export interface ProvideOptions {
  readonly check?: () => boolean;
  readonly consult?: (metadata: unknown) => boolean;
}

/**
 * 统一读取契约：默认严格访问（未声明/未激活/能力失效均抛错），
 * 显式 strict=false 为不失败的查询（任何不可用都返回 undefined）。
 */
export interface FiberContext {
  readonly uid: FiberId;
  effect(callback: EffectCallback, label?: string): Disposer;
  get<T>(key: CoeffectKey<T>, strict?: true): T;
  get<T>(key: CoeffectKey<T>, strict: false): T | undefined;
  set<T>(key: CoeffectKey<T>, value: T): Disposer;
  isolate<T>(key: CoeffectKey<T>, realm?: symbol): FiberContext;
  intercept<T>(key: CoeffectKey<T>, metadata: unknown): FiberContext;
  provide<T>(key: CoeffectKey<T>, value: T, options?: ProvideOptions): Disposer;
}

export type EffectCallback = (ctx: FiberContext) => Effect;

export type ExecuteFn = (effect: Effect, guard: () => boolean) => Promise<Disposer>;

export interface Component<
  P = unknown,
  D extends CoeffectKey<any>[] = CoeffectKey<any>[],
  R extends CoeffectKey<any>[] = CoeffectKey<any>[]
> {
  readonly name: string;
  readonly version?: string;
  readonly inject: D;
  readonly provide: R;
  /** 可接受的 coeffect 版本：键为键描述（或键名），值为可接受的版本字符串。 */
  readonly accepts?: Record<string, string>;
  apply(ctx: FiberContext, config: P): Effect | Promise<Effect>;
}

export type LifecycleState =
  | { kind: "PENDING" }
  | { kind: "DISPOSED" }
  | { kind: "FAILED"; error: unknown }
  | { kind: "LOADING"; iter: EffectIterator; dispose: Disposer; committed: View }
  | { kind: "ACTIVE"; dispose: Disposer; committed: View }
  | { kind: "UNLOADING"; dispose: Disposer; committed: View };

export type View = Map<CoeffectKey<any>, Impl>;
