import type { ExportResult } from "./index";
import type { SpoolEntry, TelemetrySpool } from "./spool";

export interface TelemetryExporter<T> {
  export(items: readonly T[]): void | ExportResult | Promise<ExportResult | void>;
}

export type TelemetryPipelineFailureReason =
  | "queue_full"
  | "shutdown"
  | "export_failed"
  | "spool_failed"
  | "spool_recovery_failed"
  | "spool_compact_failed";

export interface TelemetryPipelineFailure<T> {
  readonly reason: TelemetryPipelineFailureReason;
  readonly error: Error;
  readonly item?: T;
  readonly id?: string;
  readonly result?: ExportResult;
}

export interface TelemetryPipelineOptions<T> {
  readonly exporter: TelemetryExporter<T>;
  readonly maxQueueSize: number;
  readonly maxBatchSize: number;
  readonly maxInFlight?: 1;
  readonly maxAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly compactEveryAck?: number;
  readonly spool?: TelemetrySpool<T>;
  readonly onFailure?: (failure: TelemetryPipelineFailure<T>) => void;
}

export interface TelemetryPipelineStats {
  readonly queueSize: number;
  readonly inFlightSize: number;
  readonly maxInFlight: 1;
  readonly accepting: boolean;
}

export interface TelemetryPipeline<T> {
  readonly maxQueueSize: number;
  readonly maxBatchSize: number;
  readonly maxInFlight: 1;
  start(): Promise<void>;
  recover(): Promise<number>;
  enqueue(value: T): Promise<boolean>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): TelemetryPipelineStats;
}

interface Queued<T> {
  readonly value: T;
  readonly id?: string;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isExportResult(value: unknown): value is ExportResult {
  return typeof value === "object" && value !== null && "ok" in value &&
    typeof (value as { readonly ok?: unknown }).ok === "boolean";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createTelemetryPipeline<T>(options: TelemetryPipelineOptions<T>): TelemetryPipeline<T> {
  const maxQueueSize = positiveInteger(options.maxQueueSize, "maxQueueSize");
  const maxBatchSize = positiveInteger(options.maxBatchSize, "maxBatchSize");
  if (maxBatchSize > maxQueueSize) {
    throw new RangeError("maxBatchSize must not exceed maxQueueSize");
  }
  if (options.maxInFlight !== undefined && options.maxInFlight !== 1) {
    throw new RangeError("maxInFlight is fixed at 1");
  }
  const maxAttempts = positiveInteger(options.maxAttempts ?? 4, "maxAttempts");
  const compactEveryAck = positiveInteger(options.compactEveryAck ?? 128, "compactEveryAck");
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  if (!Number.isFinite(initialBackoffMs) || initialBackoffMs < 0 ||
      !Number.isFinite(maxBackoffMs) || maxBackoffMs < initialBackoffMs) {
    throw new RangeError("backoff bounds must be finite and satisfy 0 <= initialBackoffMs <= maxBackoffMs");
  }
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const queue: Queued<T>[] = [];
  const scheduledIds = new Set<string>();
  const blockedIds = new Set<string>();
  let idlePromise: Promise<void> | undefined;
  let resolveIdle: (() => void) | undefined;
  let reservations = 0;
  let ackCount = 0;
  let inFlight: Queued<T>[] | undefined;
  let started = false;
  let accepting = true;
  let starting: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let recovering: Promise<number> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const occupied = (): number => queue.length + reservations + (inFlight?.length ?? 0);

  const report = (failure: TelemetryPipelineFailure<T>): void => {
    try {
      options.onFailure?.(failure);
    } catch {
      // 失败通知是旁路，回调异常不能破坏有界队列状态机。
    }
  };

  const settleIfIdle = (): void => {
    if (!started || queue.length > 0 || inFlight !== undefined || reservations > 0 ||
        recovering !== undefined || draining !== undefined) return;
    const resolve = resolveIdle;
    resolveIdle = undefined;
    idlePromise = undefined;
    resolve?.();
  };

  const isIdle = (): boolean => started && queue.length === 0 && inFlight === undefined &&
    reservations === 0 && recovering === undefined && draining === undefined;

  const recoverInternal = async (capacity: number): Promise<number> => {
    if (options.spool === undefined || capacity <= 0 || blockedIds.size >= maxQueueSize) return 0;
    const excluded = [...scheduledIds, ...blockedIds];
    const entries = await options.spool.load({ limit: capacity, excludeIds: excluded });
    let added = 0;
    for (const entry of entries) {
      if (occupied() >= maxQueueSize) break;
      if (scheduledIds.has(entry.id) || blockedIds.has(entry.id)) continue;
      queue.push({ id: entry.id, value: entry.value });
      scheduledIds.add(entry.id);
      added += 1;
    }
    if (added > 0) scheduleDrain();
    return added;
  };

  const recover = (): Promise<number> => {
    if (options.spool === undefined) return Promise.resolve(0);
    if (recovering !== undefined) return recovering;
    const capacity = maxQueueSize - occupied();
    recovering = recoverInternal(capacity).finally(() => {
      recovering = undefined;
      settleIfIdle();
    });
    return recovering;
  };

  const retryDelay = (retryIndex: number, result: ExportResult): number => {
    const exponential = Math.min(maxBackoffMs, initialBackoffMs * 2 ** retryIndex);
    const jitter = Math.max(0, Math.min(1, random())) * exponential;
    const backoff = Math.min(maxBackoffMs, exponential + jitter);
    return Math.max(backoff, result.ok === false ? result.retryAfterMs ?? 0 : 0);
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatchSize);
      inFlight = batch;
      let delivered = false;
      let terminal: ExportResult | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let result: ExportResult;
        try {
          const exported: unknown = await options.exporter.export(batch.map((entry) => entry.value));
          result = isExportResult(exported) ? exported : { ok: true };
          if (result.ok && options.spool !== undefined) {
            for (const entry of batch) {
              if (entry.id === undefined) continue;
              await options.spool.ack(entry.id);
              ackCount += 1;
              if (ackCount >= compactEveryAck) {
                ackCount = 0;
                try {
                  await options.spool.compact();
                } catch (error) {
                  report({
                    reason: "spool_compact_failed",
                    error: asError(error),
                    item: entry.value,
                    id: entry.id,
                  });
                }
              }
            }
          }
        } catch (cause) {
          result = { ok: false, retryable: true, error: asError(cause) };
        }
        if (result.ok) {
          delivered = true;
          break;
        }
        terminal = result;
        if (!result.retryable || attempt + 1 >= maxAttempts) break;
        try {
          await sleep(retryDelay(attempt, result));
        } catch (cause) {
          terminal = { ok: false, retryable: true, error: asError(cause) };
          break;
        }
      }
      for (const entry of batch) {
        if (entry.id !== undefined) scheduledIds.delete(entry.id);
        if (!delivered) {
          if (entry.id !== undefined && blockedIds.size < maxQueueSize) blockedIds.add(entry.id);
          report({
            reason: "export_failed",
            error: terminal !== undefined && !terminal.ok ? terminal.error : new Error("TELEMETRY_EXPORT_FAILED"),
            item: entry.value,
            ...(entry.id === undefined ? {} : { id: entry.id }),
            ...(terminal === undefined ? {} : { result: terminal }),
          });
        }
      }
      inFlight = undefined;
    }
    if (options.spool !== undefined) {
      try {
        await recover();
      } catch (error) {
        report({ reason: "spool_recovery_failed", error: asError(error) });
      }
    }
  };

  function scheduleDrain(): void {
    if (started === false || draining !== undefined || queue.length === 0) return;
    draining = drain();
    void draining.then(() => {
      draining = undefined;
      settleIfIdle();
      scheduleDrain();
    }, (error: unknown) => {
      draining = undefined;
      inFlight = undefined;
      report({ reason: "export_failed", error: asError(error) });
      settleIfIdle();
    });
  }

  const ensureStarted = (): Promise<void> => {
    if (started) return Promise.resolve();
    if (starting !== undefined) return starting;
    starting = (async () => {
      if (options.spool !== undefined) {
        try {
          await recover();
        } catch (error) {
          report({ reason: "spool_recovery_failed", error: asError(error) });
        }
      }
      started = true;
      scheduleDrain();
      settleIfIdle();
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const reserve = (): boolean => {
    if (occupied() >= maxQueueSize) return false;
    reservations += 1;
    return true;
  };

  const flushPipeline = async (): Promise<void> => {
    await ensureStarted();
    if (options.spool !== undefined) {
      try {
        await recover();
      } catch (error) {
        report({ reason: "spool_recovery_failed", error: asError(error) });
      }
    }
    if (!isIdle()) {
      idlePromise ??= new Promise<void>((resolve) => { resolveIdle = resolve; });
      await idlePromise;
    }
    if (ackCount > 0 && options.spool !== undefined) {
      ackCount = 0;
      try {
        await options.spool.compact();
      } catch (error) {
        report({ reason: "spool_compact_failed", error: asError(error) });
      }
    }
  };

  return {
    maxQueueSize,
    maxBatchSize,
    maxInFlight: 1,
    start(): Promise<void> {
      if (shutdownPromise !== undefined) {
        return Promise.reject(new Error("TELEMETRY_PIPELINE_SHUTDOWN"));
      }
      return ensureStarted();
    },
    recover(): Promise<number> {
      if (shutdownPromise !== undefined) return Promise.resolve(0);
      return ensureStarted().then(() => recover());
    },
    async enqueue(value: T): Promise<boolean> {
      if (!accepting) {
        report({ reason: "shutdown", error: new Error("TELEMETRY_PIPELINE_SHUTDOWN"), item: value });
        return false;
      }
      await ensureStarted();
      if (!accepting) {
        report({ reason: "shutdown", error: new Error("TELEMETRY_PIPELINE_SHUTDOWN"), item: value });
        return false;
      }
      if (!reserve()) {
        report({ reason: "queue_full", error: new Error("TELEMETRY_QUEUE_FULL"), item: value });
        return false;
      }
      try {
        const entry = options.spool === undefined
          ? { value }
          : await options.spool.enqueue(value);
        const id = "id" in entry ? entry.id : undefined;
        queue.push({ value: entry.value, ...(id === undefined ? {} : { id }) });
        if (id !== undefined) scheduledIds.add(id);
        scheduleDrain();
        return true;
      } catch (error) {
        report({ reason: "spool_failed", error: asError(error), item: value });
        return false;
      } finally {
        reservations -= 1;
        settleIfIdle();
      }
    },
    flush(): Promise<void> {
      return flushPipeline();
    },
    shutdown(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      accepting = false;
      shutdownPromise = Promise.resolve().then(async () => {
        await ensureStarted();
        await flushPipeline();
      });
      return shutdownPromise;
    },
    stats(): TelemetryPipelineStats {
      return {
        queueSize: occupied(),
        inFlightSize: inFlight?.length ?? 0,
        maxInFlight: 1,
        accepting,
      };
    },
  };
}
