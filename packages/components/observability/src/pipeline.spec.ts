import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelemetryPipeline,
  type TelemetryPipelineFailure,
} from "./pipeline";
import {
  createFileTelemetrySpool,
  type SpoolEntry,
  type TelemetrySpool,
} from "./spool";
import type { ExportResult } from "./index";

const ok = (): ExportResult => ({ ok: true });

describe("TelemetryPipeline", () => {
  test("队列有界且满时显式 onFailure，maxInFlight 固定为 1", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const failures: TelemetryPipelineFailure<number>[] = [];
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 2,
      maxBatchSize: 1,
      exporter: {
        async export(items) {
          delivered.push(...items);
          await gate;
          return ok();
        },
      },
      onFailure: (failure) => failures.push(failure),
    });

    const accepted = await Promise.all([pipeline.enqueue(1), pipeline.enqueue(2), pipeline.enqueue(3)]);
    const acceptedValues = [1, 2, 3].filter((_value, index) => accepted[index]);
    expect(acceptedValues).toHaveLength(2);
    expect(accepted.filter((value) => !value)).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe("queue_full");
    expect(pipeline.stats().queueSize).toBeLessThanOrEqual(2);
    expect(pipeline.stats().inFlightSize).toBe(1);
    expect(pipeline.maxInFlight).toBe(1);

    release?.();
    await pipeline.shutdown();
    expect(delivered.sort((left, right) => left - right)).toEqual(acceptedValues.sort((left, right) => left - right));
  });

  test("pipeline 将同步 void exporter 视为成功", async () => {
    const batches: number[][] = [];
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 2,
      maxBatchSize: 2,
      exporter: { export(items) { batches.push([...items]); } },
    });
    expect(await pipeline.enqueue(1)).toBe(true);
    expect(await pipeline.enqueue(2)).toBe(true);
    await pipeline.shutdown();
    expect(batches.flat().sort((left, right) => left - right)).toEqual([1, 2]);
  });

  test("批量大小受限且同一时刻只有一个 export 在途", async () => {
    let active = 0;
    let maxActive = 0;
    const batches: number[][] = [];
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 8,
      maxBatchSize: 3,
      exporter: {
        async export(items) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          batches.push([...items]);
          await Bun.sleep(1);
          active -= 1;
          return ok();
        },
      },
    });

    await Promise.all(Array.from({ length: 7 }, (_, index) => pipeline.enqueue(index + 1)));
    await pipeline.flush();
    expect(maxActive).toBe(1);
    expect(batches.every((batch) => batch.length <= 3)).toBe(true);
    expect(batches.flat().sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await pipeline.shutdown();
  });

  test("可重试结果使用指数退避加 jitter，永久失败不重试", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const retrying = createTelemetryPipeline<number>({
      maxQueueSize: 2,
      maxBatchSize: 2,
      maxAttempts: 4,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
      random: () => 0.5,
      sleep: async (delayMs) => { delays.push(delayMs); },
      exporter: {
        async export() {
          attempts += 1;
          return attempts < 3 ? { ok: false, retryable: true, error: new Error("RETRY") } : ok();
        },
      },
    });
    expect(await retrying.enqueue(1)).toBe(true);
    await retrying.flush();
    expect(attempts).toBe(3);
    expect(delays).toEqual([15, 30]);
    await retrying.shutdown();

    let permanentAttempts = 0;
    const failures: TelemetryPipelineFailure<number>[] = [];
    const permanent = createTelemetryPipeline<number>({
      maxQueueSize: 1,
      maxBatchSize: 1,
      exporter: {
        async export() {
          permanentAttempts += 1;
          return { ok: false, retryable: false, error: new Error("BAD_REQUEST"), status: 400 };
        },
      },
      onFailure: (failure) => failures.push(failure),
    });
    expect(await permanent.enqueue(1)).toBe(true);
    await permanent.flush();
    expect(permanentAttempts).toBe(1);
    expect(failures[0]!.reason).toBe("export_failed");
    expect(failures[0]!.result?.ok).toBe(false);
    await permanent.shutdown();
  });

  test("shutdown 停止接收并 flush 已接受项目", async () => {
    const delivered: number[] = [];
    const failures: TelemetryPipelineFailure<number>[] = [];
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 4,
      maxBatchSize: 2,
      exporter: { async export(items) { delivered.push(...items); return ok(); } },
      onFailure: (failure) => failures.push(failure),
    });
    await Promise.all([pipeline.enqueue(1), pipeline.enqueue(2), pipeline.enqueue(3)]);
    await pipeline.shutdown();
    expect(delivered.sort((left, right) => left - right)).toEqual([1, 2, 3]);
    expect(pipeline.stats().accepting).toBe(false);
    expect(await pipeline.enqueue(4)).toBe(false);
    expect(failures[0]!.reason).toBe("shutdown");
    await pipeline.flush();
  });

  test("spool 持久化成功后才允许 exporter 投递", async () => {
    let finishPersist: ((entry: SpoolEntry<string>) => void) | undefined;
    const delivered: string[] = [];
    const spool: TelemetrySpool<string> = {
      async load() { return []; },
      enqueue() { return new Promise<SpoolEntry<string>>((resolve) => { finishPersist = resolve; }); },
      async ack() {},
      async compact() {},
      async close() {},
    };
    const pipeline = createTelemetryPipeline<string>({
      maxQueueSize: 1,
      maxBatchSize: 1,
      spool,
      exporter: { async export(items) { delivered.push(...items); return ok(); } },
    });
    const enqueue = pipeline.enqueue("durable-first");
    await Bun.sleep(0);
    expect(delivered).toEqual([]);
    finishPersist?.({ id: "entry-1", value: "durable-first" });
    expect(await enqueue).toBe(true);
    await pipeline.shutdown();
    expect(delivered).toEqual(["durable-first"]);
  });

  test("短生命周期 shutdown 在 idle 后强制 compact 未达阈值的 ack", async () => {
    let compactCount = 0;
    const spool: TelemetrySpool<number> = {
      async load() { return []; },
      async enqueue(value) { return { id: String(value), value }; },
      async ack() {},
      async compact() { compactCount += 1; },
      async close() {},
    };
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 1,
      maxBatchSize: 1,
      compactEveryAck: 128,
      spool,
      exporter: { async export() { return ok(); } },
    });
    expect(await pipeline.enqueue(1)).toBe(true);
    await pipeline.shutdown();
    expect(compactCount).toBe(1);
  });

  test("drain 在队列仍非空时不逐批全量 recover spool", async () => {
    let loadCalls = 0;
    let exportCalls = 0;
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const spool: TelemetrySpool<number> = {
      async load() { loadCalls += 1; return []; },
      async enqueue(value) { return { id: String(value), value }; },
      async ack() {},
      async compact() {},
      async close() {},
    };
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 4,
      maxBatchSize: 1,
      spool,
      exporter: {
        async export() {
          exportCalls += 1;
          if (exportCalls === 2) await secondGate;
          return ok();
        },
      },
    });
    await pipeline.start();
    expect(loadCalls).toBe(1);
    await Promise.all([pipeline.enqueue(1), pipeline.enqueue(2), pipeline.enqueue(3)]);
    await Bun.sleep(0);
    expect(exportCalls).toBe(2);
    expect(loadCalls).toBe(1);
    releaseSecond?.();
    await pipeline.shutdown();
  });

  test("ack 达阈值执行 compact，compact 失败只告警不重复导出", async () => {
    let ackCount = 0;
    let compactCount = 0;
    const exported: number[] = [];
    const failures: TelemetryPipelineFailure<number>[] = [];
    const spool: TelemetrySpool<number> = {
      async load() { return []; },
      async enqueue(value) { return { id: String(value), value }; },
      async ack() { ackCount += 1; },
      async compact() {
        compactCount += 1;
        throw new Error("COMPACT_FAILED");
      },
      async close() {},
    };
    const pipeline = createTelemetryPipeline<number>({
      maxQueueSize: 4,
      maxBatchSize: 2,
      compactEveryAck: 2,
      maxAttempts: 3,
      spool,
      exporter: { async export(items) { exported.push(...items); return ok(); } },
      onFailure: (failure) => failures.push(failure),
    });
    await Promise.all([pipeline.enqueue(1), pipeline.enqueue(2)]);
    await pipeline.shutdown();
    expect(exported.sort((left, right) => left - right)).toEqual([1, 2]);
    expect(ackCount).toBe(2);
    expect(compactCount).toBe(1);
    expect(failures.map((failure) => failure.reason)).toEqual(["spool_compact_failed"]);
  });

  test("文件 spool 崩溃后重放；ack 前崩溃允许至少一次重复", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-pipeline-"));
    try {
      const path = join(root, "telemetry.jsonl");
      const spool = createFileTelemetrySpool<string>({ path });
      const delivered: string[] = [];
      const crashBeforeAck: TelemetrySpool<string> = {
        ...spool,
        async ack() { throw new Error("CRASH_BEFORE_ACK"); },
      };
      const first = createTelemetryPipeline<string>({
        maxQueueSize: 1,
        maxBatchSize: 1,
        maxAttempts: 1,
        spool: crashBeforeAck,
        exporter: { async export(items) { delivered.push(...items); return ok(); } },
      });
      expect(await first.enqueue("once-or-more")).toBe(true);
      await first.shutdown();
      expect(delivered).toEqual(["once-or-more"]);
      expect(await spool.load()).toHaveLength(1);
      await spool.close();

      const restartedSpool = createFileTelemetrySpool<string>({ path });
      const restarted = createTelemetryPipeline<string>({
        maxQueueSize: 1,
        maxBatchSize: 1,
        spool: restartedSpool,
        exporter: { async export(items) { delivered.push(...items); return ok(); } },
      });
      await restarted.start();
      await restarted.shutdown();
      expect(delivered).toEqual(["once-or-more", "once-or-more"]);
      expect(await restartedSpool.load()).toEqual([]);
      await restartedSpool.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
