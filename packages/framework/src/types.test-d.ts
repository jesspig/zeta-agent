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
import type {
  Contract,
  Delta,
  DeltaOp,
  DocumentDef,
  DocumentHandle,
  Link,
  PendingDelta,
  Store,
  Table,
  Tracker,
  Tx,
} from "./objects";
import {
  acceptVersion,
  adopt,
  applyImmutable,
  defineContract,
  defineDocument,
  memoryLinkPair,
  openDocument,
  openStore,
  prepare,
  track,
  transactDocuments,
} from "./objects";

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

const contract = defineContract({
  name: "typed.greeter",
  version: "1.0",
  params: { language: "zh" },
  members: {},
  accepts: { "0.9": "1.0" },
});
const acceptedVersion: string = acceptVersion(contract, "0.9");
const fingerprint: string = contract.fingerprint;
const contractValue: Contract = contract;

// @ts-expect-error 伪造句柄缺少品牌标记
const forgedContract: Contract<unknown, unknown> = {
  name: "forged",
  version: "1.0",
  params: {},
  members: {},
  accepts: {},
  fingerprint: "00000000",
};

const store: Store = openStore();
const table: Table<{ n: number }> = store.defineTable("typed", { n: 0 });
const tableValue: { n: number } = store.read(table);

const definition: DocumentDef<{ n: number }> = defineDocument({ name: "typed-doc", initial: { n: 0 } });
const handle: DocumentHandle<{ n: number }> = openDocument(store, definition);
const txBody: (tx: Tx) => void = (tx) => {
  const draft: { n: number } = tx.draft(handle);
  const current: { n: number } | null = tx.get(handle);
  tx.put(handle, draft);
  tx.retire(handle);
  if (current === null) tx.abort();
};
const committed: Promise<void> = transactDocuments(store, txBody);

const [left, right]: readonly [Link, Link] = memoryLinkPair();
left.send({ kind: "ping" });
const offMessage: Disposer = right.onMessage(() => {});
const offClose: Disposer = left.onClose(() => {});

const tracker: Tracker = track({ n: 0 });
tracker.set(["n"], 1);
tracker.delete(["missing"]);
tracker.replaceRoot({ n: 2 });
const pending: PendingDelta = prepare(tracker);
const stale: boolean = pending.stale;
const delta: Delta = adopt(pending);
const ops: readonly DeltaOp[] = delta.ops;
const applied: { n: number } = applyImmutable({ n: 0 }, delta);

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
  contract,
  acceptedVersion,
  fingerprint,
  contractValue,
  forgedContract,
  store,
  table,
  tableValue,
  definition,
  handle,
  txBody,
  committed,
  left,
  right,
  offMessage,
  offClose,
  tracker,
  pending,
  stale,
  delta,
  ops,
  applied,
};
