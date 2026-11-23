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
}

export interface FiberContext {
  readonly uid: FiberId;
  effect(callback: EffectCallback, label?: string): Disposer;
  get<T>(key: CoeffectKey<T>): T;
  set<T>(key: CoeffectKey<T>, value: T): Disposer;
  isolate<T>(key: CoeffectKey<T>, realm?: symbol): FiberContext;
  intercept<T>(key: CoeffectKey<T>, metadata: unknown): FiberContext;
  provide<T>(key: CoeffectKey<T>, value: T): Disposer;
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
