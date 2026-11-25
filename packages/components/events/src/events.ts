import type { Disposer, FiberContext } from "@zeta-agent/cordis/types";
import type { DispatchOptions, EventBus, EventName, Listener, WaterfallListener } from "./types";

export type { DispatchOptions, EventBus, EventName, Listener, WaterfallListener } from "./types";

export interface EventBusOptions {
  /** 同步 emit 的监听器失败（含异步拒绝）出口；未提供时仅吞掉，避免未处理拒绝。 */
  readonly onError?: (error: unknown) => void;
  /** 提供时 listener 注册走 ctx.effect，宿主组件卸载即自动注销。 */
  readonly ctx?: Pick<FiberContext, "effect">;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const listeners = new Map<string, Array<{ listener: Listener<EventName>; scope?: symbol }>>();

  function on<N extends EventName>(
    name: N,
    listener: Listener<N>,
    opts?: DispatchOptions
  ): Disposer {
    const entry = { listener: listener as Listener<EventName>, scope: opts?.scope };
    const bucket = listeners.get(name) ?? [];
    bucket.push(entry);
    listeners.set(name, bucket);
    const detach: Disposer = () => {
      const current = listeners.get(name) ?? [];
      listeners.set(
        name,
        current.filter((item) => item !== entry)
      );
    };
    // 宿主 ctx.effect 是唯一注册入口：组件卸载时逆自动执行，不留悬挂监听。
    return options.ctx ? options.ctx.effect(() => detach) : detach;
  }

  function matching(name: EventName, opts?: DispatchOptions): Listener<EventName>[] {
    return (listeners.get(name) ?? [])
      .filter((entry) => opts?.scope === undefined || entry.scope === opts.scope)
      .map((entry) => entry.listener);
  }

  return {
    on,
    emit(name, payload, opts) {
      for (const listener of matching(name, opts)) {
        try {
          const result = listener(payload);
          // 异步监听器拒绝也走同一出口，避免未处理 Promise 拒绝。
          if (result !== undefined && typeof (result as PromiseLike<unknown>).then === "function") {
            Promise.resolve(result).catch((error) => options.onError?.(error));
          }
        } catch (error) {
          options.onError?.(error);
        }
      }
    },
    async parallel(name, payload, opts) {
      const results = await Promise.allSettled(
        matching(name, opts).map((listener) => Promise.resolve().then(() => listener(payload)))
      );
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, `event ${name} parallel 失败`);
    },
    async serial(name, payload, opts) {
      for (const listener of matching(name, opts)) {
        const result = await listener(payload);
        // false/null/undefined 是"继续"信号；其余返回值立即作为串行结果返回。
        if (result !== false && result !== null && result !== undefined) return result;
      }
      return undefined;
    },
    async bail(name, payload, opts) {
      let bailed = false;
      for (const listener of matching(name, opts)) {
        const result = await listener(payload);
        // 显式判定：0 与空字符串也算 bailed，只有 false/null/undefined 继续。
        if (result !== false && result !== null && result !== undefined) {
          bailed = true;
          break;
        }
      }
      return bailed;
    },
    async waterfall(name, payload, opts) {
      let current: unknown = payload;
      for (const listener of matching(name, opts)) {
        let advanced = false;
        await (listener as WaterfallListener<EventName>)(current as never, (value) => {
          if (advanced) throw new Error("waterfall next() 重复调用");
          advanced = true;
          current = value;
        });
        // 不调用 next 就不推进；listener 的返回值不改变 current。
      }
      return current as never;
    },
  };
}
