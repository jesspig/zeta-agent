import { observeState, sameObservation } from "./observation";

export interface FiberSnapshot {
  readonly uid: string;
  readonly state: { readonly kind: string };
}

export interface TestContextLike {
  fibers(): readonly FiberSnapshot[];
}

/** teardown 的嵌套 yield 位置：正确实现必须在 acquire 的深度逆序撤回。 */
export interface TeardownPosition {
  /** teardown 实际被 yield 的嵌套深度。 */
  readonly yieldDepth: number;
  /** 资源 acquire 时的嵌套深度；teardown 必须回到同一深度。 */
  readonly acquiredDepth: number;
  /** 作用域标识；同作用域内按 acquire 逆序撤回。 */
  readonly scopeId: string;
  /** 同作用域内的 acquire / teardown 序号。 */
  readonly acquireOrder: number;
  readonly teardownOrder: number;
}

export interface Disposable {
  readonly uid: string;
  readonly key: string;
  readonly inverseCalls: number;
  dispose(): void;
  readonly teardown?: TeardownPosition;
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

/** 不变量：逆调用恰好一次 + teardown 位于正确嵌套 yield 位置 + 快照回到基线。 */
export function assertNoResidue(ctx: ResidueContext, baseline: unknown): void {
  const effects = ctx.effects();
  const leaked = effects.filter((effect) => effect.inverseCalls !== 1);
  if (leaked.length > 0) {
    const details = leaked
      .map((effect) => `uid=${effect.uid} key=${effect.key} inverseCalls=${effect.inverseCalls}`)
      .join("; ");
    throw new Error(`assertNoResidue: ${details}`);
  }

  // 只查调用次数无法发现"在错误嵌套层 teardown"的假阳性：额外核对深度与 LIFO 顺序。
  const positioned = effects
    .filter((effect) => effect.teardown !== undefined)
    .map((effect) => ({ effect, position: effect.teardown as TeardownPosition }));
  for (const { effect, position } of positioned) {
    if (position.yieldDepth !== position.acquiredDepth) {
      throw new Error(
        `assertNoResidue: teardown 嵌套位置错误 uid=${effect.uid} ` +
          `yieldDepth=${position.yieldDepth} acquiredDepth=${position.acquiredDepth}`
      );
    }
  }
  const byScope = new Map<string, typeof positioned>();
  for (const entry of positioned) {
    const list = byScope.get(entry.position.scopeId) ?? [];
    list.push(entry);
    byScope.set(entry.position.scopeId, list);
  }
  for (const [scopeId, list] of byScope) {
    const byAcquire = [...list].sort(
      (left, right) => left.position.acquireOrder - right.position.acquireOrder
    );
    const byTeardown = [...list].sort(
      (left, right) => left.position.teardownOrder - right.position.teardownOrder
    );
    for (let index = 0; index < byAcquire.length; index += 1) {
      const expected = byTeardown[byAcquire.length - 1 - index]!;
      if (byAcquire[index]!.effect.uid !== expected.effect.uid) {
        throw new Error(
          `assertNoResidue: 作用域 ${scopeId} teardown 非 LIFO uid=${expected.effect.uid}`
        );
      }
    }
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

/** 故障注入：包裹函数，在指定调用序号（或自定义条件）抛出指定错误。 */
export interface FaultRule {
  /** 第几次调用注入（0-based），缺省 0。 */
  readonly onCall?: number;
  /** 抛出的错误，缺省 Error("faultInject")。 */
  readonly error?: unknown;
  /** 自定义命中条件，优先于 onCall。 */
  readonly when?: (callIndex: number, args: readonly unknown[]) => boolean;
}

export function faultInject<Args extends readonly unknown[], Result>(
  fn: (...args: Args) => Result,
  rule: FaultRule = {}
): (...args: Args) => Result {
  const error = rule.error ?? new Error("faultInject");
  let callIndex = 0;
  return (...args: Args): Result => {
    const index = callIndex++;
    const hit = rule.when
      ? rule.when(index, args)
      : rule.onCall === undefined
        ? index === 0
        : index === rule.onCall;
    if (hit) throw error;
    return fn(...args);
  };
}

/** 可变测试上下文：为 assertQuiescent / assertNoResidue 提供一致的观察面。 */
export interface MutableTestContext extends TestContextLike, ResidueContext {
  setFibers(fibers: readonly FiberSnapshot[]): void;
  setEffects(effects: readonly Disposable[]): void;
  setSnapshot(snapshot: unknown): void;
  addEffect(effect: Disposable): void;
}

export function createTestContext(
  initial: {
    readonly fibers?: readonly FiberSnapshot[];
    readonly effects?: readonly Disposable[];
    readonly snapshot?: unknown;
  } = {}
): MutableTestContext {
  let fibers = [...(initial.fibers ?? [])];
  let effects = [...(initial.effects ?? [])];
  let snapshot: unknown = initial.snapshot ?? {};
  return {
    fibers: () => fibers,
    effects: () => effects,
    snapshot: () => snapshot,
    setFibers: (next) => { fibers = [...next]; },
    setEffects: (next) => { effects = [...next]; },
    setSnapshot: (next) => { snapshot = next; },
    addEffect: (effect) => { effects.push(effect); },
  };
}

/** 依赖环静态检测：输入 模块→依赖 的邻接表，返回所有环（每个环首尾同节点）。 */
export function detectDependencyCycles(
  graph: Readonly<Record<string, readonly string[]>>
): readonly (readonly string[])[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    const status = state.get(node) ?? 0;
    if (status === 1) {
      const start = stack.indexOf(node);
      cycles.push(stack.slice(start).concat(node));
      return;
    }
    if (status === 2) return;
    state.set(node, 1);
    stack.push(node);
    for (const dependency of graph[node] ?? []) visit(dependency);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of Object.keys(graph)) visit(node);
  return cycles;
}
