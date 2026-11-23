import type {
  CoeffectKey,
  Component,
  Disposer,
  Effect,
  EffectCallback,
  EffectIterator,
  ExecuteFn,
  FiberContext,
  Impl,
  LifecycleState,
} from "./types";
import type { ComponentSpec } from "./context";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const disposer: Disposer = () => {};

const effects: Effect[] = [
  disposer,
  [disposer, disposer],
  Promise.resolve(disposer),
  (async function* () {
    yield disposer;
  })(),
];

type _EffectHasFourForms = Expect<
  Equal<Effect, Disposer | Iterable<Disposer> | Promise<Disposer> | AsyncIterable<Disposer>>
>;

const iterator: EffectIterator = (async function* () {
  yield disposer;
})();

const callback: EffectCallback = (_ctx: FiberContext) => disposer;

const key: CoeffectKey<number> = {
  namespace: "@zeta-agent/test",
  name: "counter",
  symbol: Symbol("@zeta-agent/test.counter"),
};

const impl: Impl = {
  uid: "fiber-1",
  value: 42,
  check: () => true,
  dependents: new Set<string>(),
  isolate: Symbol("realm-1"),
};

const checkResult: boolean | undefined = impl.check?.();
const dependentCount: number = impl.dependents.size;

declare const execute: ExecuteFn;
const execution: Promise<Disposer> = execute(effects[0]!, () => true);

const component: Component<number> = {
  name: "test-component",
  inject: [],
  provide: [],
  apply: (_ctx: FiberContext, _config: number) => disposer,
};

const versionedComponent: Component<number> = {
  name: "versioned-component",
  inject: [],
  provide: [],
  accepts: { "@zeta-agent/test.counter": "1.0", counter: "1.0" },
  apply: (_ctx: FiberContext, _config: number) => disposer,
};
const accepted: Record<string, string> | undefined = versionedComponent.accepts;

const versionedSpec: ComponentSpec<number> = {
  name: "versioned-spec",
  apply: (_ctx: FiberContext, _config: number) => disposer,
  accepts: { counter: "1.0" },
};
const specAccepted: Record<string, string> | undefined = versionedSpec.accepts;

function assertNever(value: never): never {
  throw new Error(`unexpected state: ${String(value)}`);
}

function stateKind(state: LifecycleState): string {
  switch (state.kind) {
    case "PENDING":
      return "pending";
    case "LOADING":
      return "loading";
    case "ACTIVE":
      return "active";
    case "UNLOADING":
      return "unloading";
    case "FAILED":
      return "failed";
    case "DISPOSED":
      return "disposed";
    default:
      return assertNever(state);
  }
}

export type {
  _EffectHasFourForms,
  accepted,
  checkResult,
  specAccepted,
  dependentCount,
  execution,
  component,
  effects,
  iterator,
  callback,
  key,
  stateKind,
};
