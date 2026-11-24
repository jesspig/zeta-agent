/**
 * Reference（IF-18）：live / loading / failed / denied / ended 五态句柄。
 *
 * Reference 绑定到某一次 attempt（代码代次），因此旧句柄上的调用始终跑旧代码；
 * release 幂等，只释放自己持有的那一份 lease，lease 归零时 attempt 才能被回收。
 */
export type ReferenceState = "live" | "loading" | "failed" | "denied" | "ended";

export interface ReferenceSnapshot<T> {
  readonly state: ReferenceState;
  readonly value: T | undefined;
  readonly error?: unknown;
  readonly reason?: string;
  readonly generation: number;
}

export interface ReferenceHandle<T> {
  snapshot(): ReferenceSnapshot<T>;
  /** 等待进入非 loading 状态（live/failed/denied/ended）。 */
  readonly ready: Promise<void>;
  /** 释放本句柄持有的 lease；幂等。 */
  release(): void;
  readonly released: boolean;
}

export interface Reference<T> {
  readonly state: ReferenceState;
  /** 只有 live/loading（保留旧值）时可读取；denied/ended 永远为 undefined。 */
  readonly value: T | undefined;
  readonly error?: unknown;
  readonly reason?: string;
  readonly generation: number;
  readonly released: boolean;
  readonly ready: Promise<void>;
  release(): void;
}

export function createReference<T>(handle: ReferenceHandle<T>): Reference<T> {
  return {
    get state() {
      return handle.snapshot().state;
    },
    get value() {
      return handle.snapshot().value;
    },
    get error() {
      return handle.snapshot().error;
    },
    get reason() {
      return handle.snapshot().reason;
    },
    get generation() {
      return handle.snapshot().generation;
    },
    get released() {
      return handle.released;
    },
    get ready() {
      return handle.ready;
    },
    release() {
      handle.release();
    },
  };
}
