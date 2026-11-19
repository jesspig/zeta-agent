import { observeState, sameObservation } from "./observation";

export interface FiberSnapshot {
  readonly uid: string;
  readonly state: { readonly kind: string };
}

export interface TestContextLike {
  fibers(): readonly FiberSnapshot[];
}

export interface Disposable {
  readonly uid: string;
  readonly key: string;
  readonly inverseCalls: number;
  dispose(): void;
}

export interface ResidueContext {
  effects(): readonly Disposable[];
  snapshot(): unknown;
}

const SETTLED = new Set(["PENDING", "ACTIVE", "FAILED", "DISPOSED"]);

export async function assertQuiescent(
  ctx: TestContextLike,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const unsettled = ctx.fibers().filter((fiber) => !SETTLED.has(fiber.state.kind));
    if (unsettled.length === 0) return;
    if (Date.now() >= deadline) {
      const uids = unsettled.map((fiber) => fiber.uid).join(",");
      const kinds = unsettled.map((fiber) => fiber.state.kind).join(",");
      throw new Error(`assertQuiescent: fiber 未静止 uid=${uids} kind=${kinds}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function assertNoResidue(ctx: ResidueContext, baseline: unknown): void {
  const leaked = ctx.effects().filter((effect) => effect.inverseCalls !== 1);
  if (leaked.length > 0) {
    const details = leaked
      .map((effect) => `uid=${effect.uid} key=${effect.key} inverseCalls=${effect.inverseCalls}`)
      .join("; ");
    throw new Error(`assertNoResidue: ${details}`);
  }
  if (!sameObservation(ctx.snapshot(), baseline)) {
    throw new Error("assertNoResidue: 快照未回到基线 key=@@store");
  }
}

export function replayConfig<T>(
  orders: readonly (readonly T[])[],
  run: (sequence: readonly T[]) => unknown
): unknown {
  if (orders.length === 0) {
    throw new Error("replayConfig: 至少需要一个加载顺序");
  }
  const observed = orders.map((order) => ({ order, state: run(order) }));
  const first = observed[0]!;
  for (const item of observed.slice(1)) {
    if (!sameObservation(item.state, first.state)) {
      throw new Error(
        `replayConfig: 汇合失败 order=${item.order.map(String).join(",")} state=${observeState(item.state)}`
      );
    }
  }
  return first.state;
}

export function observeDispose(
  effects: readonly Disposable[],
  disposeAll: (effects: readonly Disposable[]) => readonly string[]
): string[] {
  const actual = disposeAll(effects);
  const expected = effects.map((effect) => effect.uid).reverse();
  if (!sameObservation(actual, expected)) {
    throw new Error(`observeDispose: 逆序异常 uid_sequence=${actual.join(",")} expected=${expected.join(",")}`);
  }
  return [...actual];
}
