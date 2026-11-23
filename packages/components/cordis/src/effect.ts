import type { Disposer, Effect } from "@zeta-agent/framework";
// 观测桥按需读取：未安装时只多一次取值与判空，不产生 meta 对象、不改 effect 内核语义。
import { getActiveEffectBridge } from "../../observability/src/index";

export interface EffectHost {
  readonly uid: string;
  dispose: Disposer;
  readonly effects: readonly Disposer[];
  effect(callback: (ctx: EffectHost) => Effect, label?: string): Disposer;
}

export const NOOP: Disposer = () => {};

/** 单个 effect 内串行按传入顺序执行，用于构造 LIFO 逆。 */
export function composeDispose(...disposers: readonly Disposer[]): Disposer {
  return async () => {
    for (const dispose of disposers) {
      await dispose();
    }
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
    for (const dispose of effect as Iterable<Disposer>) {
      yield dispose;
    }
  }
}

/**
 * exact disposer 身份：只组合调用方 yield 出来的那个 disposer，
 * 不另造包装函数；包装会把 teardown 变成并发兄弟，破坏嵌套 LIFO 时序。
 */
export async function execute(effect: Effect, guard: () => boolean): Promise<Disposer> {
  const iterator = toIterator(effect);
  let inverse: Disposer = NOOP;
  try {
    while (guard()) {
      const { value, done } = await iterator.next();
      if (value) inverse = composeDispose(value, inverse);
      if (done) break;
    }
  } catch (error) {
    // 迭代中途失败：回收已取得的逆动作后再抛出原错误，避免资源残留。
    await inverse();
    throw error;
  }
  return inverse;
}

export function createEffectHost(uid: string): EffectHost {
  const effects: Disposer[] = [];
  const host: EffectHost = {
    uid,
    dispose: NOOP,
    effects,
    effect: (callback, label) => effect(host, callback, label),
  };
  return host;
}

/**
 * armed 一次性：首次 dispose 同时中断在途迭代并回收已 yield 的逆；
 * 逆前插到 ctx.dispose，保持单个 effect 内的 LIFO。
 */
export function effect(
  ctx: EffectHost,
  callback: (ctx: EffectHost) => Effect,
  label?: string
): Disposer {
  const observer = getActiveEffectBridge();
  if (observer) {
    observer.emit({
      label: label ?? ctx.uid,
      runId: observer.runId,
      fiberUid: ctx.uid,
      children: [],
    });
  }
  let armed = true;
  const task = execute(callback(ctx), () => armed);
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

/** fiber 级：逆序启动全部顶层逆并并发执行；有依赖顺序的清理交给 effect 内部的 LIFO。 */
export async function unloadHost(ctx: EffectHost): Promise<void> {
  await Promise.all([...ctx.effects].reverse().map((dispose) => dispose()));
}
