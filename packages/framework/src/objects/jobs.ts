import type { Disposer } from "../types";
import { hashValue } from "./contract";
import type { DocumentHandle } from "./document";
import type { Store } from "./store";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  readonly key: string;
  /** 稳定幂等键：重试/崩溃复用同一条记录，不重复生效。 */
  readonly idempotencyKey: string;
  readonly payload: unknown;
  status: JobStatus;
  attempts: number;
  result?: unknown;
  error?: unknown;
}

export interface JobContext {
  readonly key: string;
  readonly generation: number;
  readonly attempt: number;
}

export type JobHandler = (payload: unknown, context: JobContext) => unknown | Promise<unknown>;

export interface JobOptions {
  readonly handler: JobHandler;
  readonly generation?: number;
  readonly maxAttempts?: number;
}

export interface JobRunner {
  /** 同 key 重复入队返回既有记录，不产生第二条副作用。 */
  enqueue(key: string, payload: unknown): Promise<JobRecord>;
  /** 只处理调用时刻处于 queued 的作业；期间被 crash 退回的不会被本轮重新捞起。 */
  run(): Promise<void>;
  status(key: string): JobStatus | undefined;
  record(key: string): JobRecord | undefined;
  readonly pending: number;
  readonly active: number;
  /** worker 崩溃：running 退回 queued；在途执行结果因 attempt 过期被忽略。 */
  crash(workerId?: string): void;
  close(): Promise<void>;
}

export function createJobRunner(options: JobOptions): JobRunner {
  if (typeof options.handler !== "function") throw new Error("INVALID_JOB_HANDLER");
  const generation = options.generation ?? 0;
  const maxAttempts = options.maxAttempts ?? 3;
  const records = new Map<string, JobRecord>();
  let closed = false;
  let running = 0;

  function assertOpen(): void {
    if (closed) throw new Error("JOB_RUNNER_CLOSED");
  }

  async function execute(record: JobRecord, token: number): Promise<void> {
    try {
      const result = await options.handler(record.payload, { key: record.key, generation, attempt: token });
      if (record.attempts !== token || record.status !== "running") return;
      record.status = "done";
      record.result = result;
    } catch (error) {
      if (record.attempts !== token || record.status !== "running") return;
      record.error = error;
      record.status = record.attempts < maxAttempts ? "queued" : "failed";
    } finally {
      running = Math.max(0, running - 1);
    }
  }

  return {
    async enqueue(key, payload) {
      assertOpen();
      if (typeof key !== "string" || key.length === 0) throw new Error("INVALID_JOB_KEY");
      const existing = records.get(key);
      if (existing !== undefined) return existing;
      const record: JobRecord = { key, idempotencyKey: key, payload, status: "queued", attempts: 0 };
      records.set(key, record);
      return record;
    },
    async run() {
      assertOpen();
      const keys = [...records.entries()]
        .filter(([, record]) => record.status === "queued")
        .map(([key]) => key);
      for (const key of keys) {
        const record = records.get(key) as JobRecord;
        if (record.status !== "queued") continue;
        record.status = "running";
        record.attempts += 1;
        running += 1;
        await execute(record, record.attempts);
      }
    },
    status(key) {
      return records.get(key)?.status;
    },
    record(key) {
      return records.get(key);
    },
    get pending() {
      let count = 0;
      for (const record of records.values()) if (record.status === "queued") count += 1;
      return count;
    },
    get active() {
      return running;
    },
    crash() {
      for (const record of records.values()) {
        if (record.status === "running") record.status = "queued";
      }
    },
    async close() {
      closed = true;
    },
  };
}

/** store 版本计数器的原生变更馈送：版本变化即投递最新已提交值。 */
export function nativeWatch<Doc>(
  store: Store,
  handle: DocumentHandle<Doc>,
  listener: (doc: Doc | null, version: number) => void
): Disposer {
  let stopped = false;
  let version = store.version(handle.table);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (stopped) return;
    const next = store.version(handle.table);
    if (next !== version) {
      version = next;
      listener(store.read(handle.table), next);
    }
    if (!stopped) timer = setTimeout(check, 1);
  };
  timer = setTimeout(check, 1);
  return (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export interface Derived<T> {
  readonly value: T;
  readonly version: number;
  stop(): void;
}

export function derive<Doc, T>(
  store: Store,
  handle: DocumentHandle<Doc>,
  compute: (doc: Doc | null) => T
): Derived<T> {
  let value = compute(store.read(handle.table));
  let version = store.version(handle.table);
  const stop = nativeWatch(store, handle, (doc, next) => {
    value = compute(doc);
    version = next;
  });
  return {
    get value(): T {
      return value;
    },
    get version(): number {
      return version;
    },
    stop,
  };
}

export interface LiveQuery<T> {
  readonly value: T;
  stop(): void;
}

/** 多依赖 live query：任一依赖提交即重算，按规范化指纹去重通知。 */
export function liveQuery<T>(
  store: Store,
  handles: readonly DocumentHandle<any>[],
  compute: () => T,
  listener: (value: T) => void
): LiveQuery<T> {
  let value = compute();
  let fingerprint = hashValue(value);
  const stops = handles.map((handle) =>
    nativeWatch(store, handle, () => {
      const next = compute();
      const nextFingerprint = hashValue(next);
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      value = next;
      listener(next);
    })
  );
  return {
    get value(): T {
      return value;
    },
    stop(): void {
      for (const stop of stops) stop();
    },
  };
}
