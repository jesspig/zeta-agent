import type { Disposer } from "@zeta-agent/framework";
import type { DispatchOptions, EventBus, EventName, Listener, WaterfallListener } from "./types";

export type { DispatchOptions, EventBus, EventName, Listener, WaterfallListener } from "./types";

export interface EventBusOptions {
  /** 同步 emit 的监听器失败（含异步拒绝）出口；未提供时仅吞掉，避免未处理拒绝。 */
  readonly onError?: (error: unknown) => void;
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
    return () => {
      const current = listeners.get(name) ?? [];
      listeners.set(
        name,
        current.filter((item) => item !== entry)
      );
    };
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
      for (const listener of matching(name, opts)) await listener(payload);
    },
    async bail(name, payload, opts) {
      for (const listener of matching(name, opts)) {
        if (await listener(payload)) return true;
      }
      return false;
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
      }
      return current as never;
    },
  };
}
