import type { Disposer, Effect, EffectMeta, EffectObserver } from "./types";

let activeEffectObserver: EffectObserver | undefined;

/** 兼容全局安装入口；生产 Context 应通过 constructor observer 注入。 */
export function setActiveEffectObserver(observer: EffectObserver | null): Disposer {
  const previous = activeEffectObserver;
  activeEffectObserver = observer ?? undefined;
  return () => {
    activeEffectObserver = previous;
  };
}

function emitEffect(observer: EffectObserver | undefined, meta: EffectMeta): void {
  if (!observer) return;
  try {
    observer.emit(meta);
  } catch {
    // 观测是旁路，handler 失败不得改变 effect 生命周期。
  }
}

export interface EffectHost {
  readonly uid: string;
  readonly observer?: EffectObserver;
  readonly meta: EffectMeta;
  parentEffect?: EffectMeta;
  dispose: Disposer;
  readonly effects: readonly Disposer[];
  effect(callback: (ctx: EffectHost) => Effect, label?: string): Disposer;
}

export const NOOP: Disposer = () => {};

/** 所有逆均尝试；单 effect 内保持传入顺序，从而与前插组合构成 LIFO。 */
export function composeDispose(...disposers: readonly Disposer[]): Disposer {
  return async () => {
    const errors: unknown[] = [];
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "effect teardown 失败");
  };
}

export async function* toIterator(effect: Effect): AsyncIterableIterator<Disposer> {
  if (typeof effect === "function") {
    yield effect;
    return;
  }
  if (effect instanceof Promise) {
    yield await effect;
    return;
  }
  if (Symbol.asyncIterator in Object(effect)) {
    for await (const dispose of effect as AsyncIterable<Disposer>) {
      yield dispose;
    }
    return;
  }
  if (Symbol.iterator in Object(effect)) {
    for (const dispose of effect as Iterable<Disposer>) yield dispose;
  }
}

/** exact disposer 身份：只组合调用方 yield 出来的那个 disposer。 */
export async function execute(effect: Effect, guard: () => boolean): Promise<Disposer> {
  const iterator = toIterator(effect);
  let inverse: Disposer = NOOP;
  let completed = false;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await iterator.return?.();
  };
  try {
    while (guard()) {
      const { value, done } = await iterator.next();
      if (value) inverse = composeDispose(value, inverse);
      if (done) {
        completed = true;
        break;
      }
    }
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await inverse();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await close();
    } catch (closeError) {
      errors.push(closeError);
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, "effect 迭代失败且清理失败");
  }
  if (!completed) await close();
  return inverse;
}

export function createEffectHost(uid: string, observer?: EffectObserver): EffectHost {
  const effects: Disposer[] = [];
  const host: EffectHost = {
    uid,
    ...(observer ? { observer } : {}),
    meta: { label: uid, ...(observer?.runId ? { runId: observer.runId } : {}), fiberUid: uid, children: [] },
    dispose: NOOP,
    effects,
    effect: (callback, label) => effect(host, callback, label),
  };
  return host;
}

/** armed 一次性：首次 dispose 同时中断在途迭代并回收已 yield 的逆。 */
export function effect(
  ctx: EffectHost,
  callback: (ctx: EffectHost) => Effect,
  label?: string
): Disposer {
  const observer = ctx.observer ?? activeEffectObserver;
  const parent = ctx.parentEffect;
  const meta: EffectMeta = {
    label: label ?? ctx.uid,
    ...(observer?.runId ? { runId: observer.runId } : {}),
    fiberUid: ctx.uid,
    children: [],
  };
  (parent?.children ?? ctx.meta.children).push(meta);
  const previousParent = ctx.parentEffect;
  ctx.parentEffect = meta;
  let source: Effect;
  try {
    source = callback(ctx);
  } finally {
    ctx.parentEffect = previousParent;
  }
  if (observer && !parent) emitEffect(observer, meta);

  let armed = true;
  const task = execute(source, () => armed);
  const dispose: Disposer = async () => {
    if (!armed) return;
    armed = false;
    const recover = await task;
    await recover();
  };
  (ctx.effects as Disposer[]).push(dispose);
  ctx.dispose = composeDispose(dispose, ctx.dispose);
  return dispose;
}

/** fiber 级：逆序启动全部顶层逆并并发执行，全部尝试后聚合错误。 */
export async function unloadHost(ctx: EffectHost): Promise<void> {
  const pending = [...ctx.effects].reverse();
  (ctx.effects as Disposer[]).length = 0;
  ctx.dispose = NOOP;
  const results = await Promise.allSettled(pending.map((dispose) => dispose()));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "fiber effect teardown 失败");
}
