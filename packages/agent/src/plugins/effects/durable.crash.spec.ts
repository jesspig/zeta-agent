import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableEffects,
  createFileDurableJournal,
  later,
  type DurableIntent,
  type DispatchContext,
} from "./durable";
import type { OutboxSnapshot } from "@zeta-agent/security";

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zeta-durable-crash-"));
  return { file: join(dir, "outbox.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("T-14 durable effects 两崩溃窗口 / 并发 / 对账", () => {
  test("窗口一（commit 前）与窗口二（dispatch 后回执前）都不重复可观察副作用", async () => {
    const { file, cleanup } = tempFile();
    try {
      const dispatched: string[] = [];
      const dispatch = async (intent: DurableIntent): Promise<string> => {
        dispatched.push(`${intent.seq}:${intent.kind}:${intent.key}`);
        return "ok";
      };
      const journal = createFileDurableJournal(file);
      const first = createDurableEffects(dispatch, { journal });
      first.enqueue("message", "m1", { text: "hello" });
      first.enqueue("file", "f1", "data");
      expect(existsSync(file)).toBe(true);

      // 崩溃窗口一：已经入队但尚未派发。
      const afterCrash = createDurableEffects(dispatch, { journal: createFileDurableJournal(file) });
      expect(afterCrash.pending().map((intent) => intent.seq)).toEqual([1, 2]);
      const receipts = await afterCrash.commit();
      expect(receipts).toHaveLength(2);
      expect(dispatched).toEqual(["1:message:m1", "2:file:f1"]);

      // 崩溃窗口二：伪造 journal 中一条已 dispatching 但无回执的意图。
      const snapshot = createFileDurableJournal(file).load() as OutboxSnapshot;
      const crashedSeq = snapshot.seq + 1;
      const injected: OutboxSnapshot = {
        ...snapshot,
        seq: crashedSeq,
        pending: [
          ...snapshot.pending,
          {
            kind: "message",
            key: "crashed",
            seq: crashedSeq,
            payload: "x",
            idempotencyKey: "message\u0000crashed",
            state: "dispatching",
            generation: 1,
            attempts: 1,
          },
        ],
        seen: [...snapshot.seen, "message\u0000crashed"],
      };
      createFileDurableJournal(file).save(injected);

      const unknownRun = createDurableEffects(dispatch, { journal: createFileDurableJournal(file) });
      expect(unknownRun.unknownIntents().map((intent) => intent.key)).toEqual(["crashed"]);
      expect(await unknownRun.commit()).toEqual([]);
      expect(dispatched).toEqual(["1:message:m1", "2:file:f1"]);
      expect(unknownRun.reconcile("crashed", true, "manual-reconciled")).toMatchObject({
        kind: "message",
        key: "crashed",
        ok: true,
        value: "manual-reconciled",
      });
      expect(dispatched).toEqual(["1:message:m1", "2:file:f1"]);
    } finally {
      cleanup();
    }
  });

  test("并发 commit 只派发一次，且幂等键贯穿每次 dispatch", async () => {
    const contexts: DispatchContext[] = [];
    const dispatched: string[] = [];
    const effects = createDurableEffects(
      (intent, context) => {
        contexts.push(context);
        dispatched.push(`${intent.kind}:${intent.key}`);
        return "ok";
      },
      { sleep: async () => {} }
    );
    effects.enqueue("message", "m1", "hello");
    effects.enqueue("file", "f1", "data");
    const [a, b] = await Promise.all([effects.commit(), effects.commit()]);
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
    expect(dispatched).toEqual(["message:m1", "file:f1"]);
    expect(contexts.map((context) => context.idempotencyKey)).toEqual(["message\u0000m1", "file\u0000f1"]);
  });

  test("跨回合同参数不重复：相同 (kind,key,payload) 只入队派发一次", async () => {
    const dispatched: string[] = [];
    const effects = createDurableEffects((intent) => {
      dispatched.push(`${intent.kind}:${intent.key}:${JSON.stringify(intent.payload)}`);
      return "ok";
    });
    effects.enqueue("message", "m1", { text: "same" });
    await effects.commit();
    // 下一回合收到完全相同的参数，幂等键仍然命中。
    effects.enqueue("message", "m1", { text: "same" });
    await effects.commit();
    expect(dispatched).toEqual(['message:m1:{"text":"same"}']);
    expect(effects.receipts()).toHaveLength(1);
  });

  test("generation/retry/Later/health：失败重试不换幂等键，Later 不计数，连续失败停止派发", async () => {
    let now = 0;
    let attempts = 0;
    const contexts: DispatchContext[] = [];
    const effects = createDurableEffects(
      (_intent, context) => {
        contexts.push(context);
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        if (attempts === 2) later(10);
        return "ok";
      },
      { now: () => now, maxAttempts: 3, healthThreshold: 3, sleep: async () => {} }
    );
    effects.enqueue("message", "m1", "hello");
    expect(await effects.commit()).toEqual([]);
    expect(contexts).toHaveLength(2);
    expect(effects.dispatchable()).toEqual([]);
    expect(effects.health()).toMatchObject({ ok: true, consecutiveFailures: 0 });

    now = 10;
    effects.retryDeferred();
    const first = await effects.commit();
    expect(first).toHaveLength(1);
    expect(contexts).toHaveLength(3);
    expect(new Set(contexts.map((context) => context.idempotencyKey))).toEqual(new Set(["message\u0000m1"]));
    expect(contexts[0]!.generation).toBe(1);
    expect(contexts[1]!.generation).toBeGreaterThan(contexts[0]!.generation);
    expect(contexts[2]!.generation).toBeGreaterThan(contexts[1]!.generation);

    const failing = createDurableEffects(
      () => {
        throw new Error("permanent");
      },
      { maxAttempts: 1, healthThreshold: 1, sleep: async () => {} }
    );
    failing.enqueue("message", "bad", "x");
    failing.enqueue("message", "never-dispatched", "y");
    expect(await failing.commit()).toHaveLength(1);
    expect(failing.health().ok).toBe(false);
    expect(failing.pending().map((intent) => intent.key)).toEqual(["never-dispatched"]);
    failing.resetHealth();
    expect(failing.health().ok).toBe(true);
  });
});

describe("T-14 真实 kill-during-write 崩溃注入", () => {
  test("子进程在 temp-writing 阶段被真实 kill：目标快照完整，恢复后只派发未 settle 的意图", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-durable-kill-"));
    const file = join(dir, "outbox.json");
    const child = join(import.meta.dir, "fixtures/journal-crash.child.mjs");
    const proc = Bun.spawn([process.execPath, child, file], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawReady = false;
      let sawTempWriting = false;
      while (!sawTempWriting) {
        const read = await reader.read();
        if (read.done === true) break;
        buffer += decoder.decode(read.value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (line === "READY") sawReady = true;
          if (line === "STAGE:temp-writing") sawTempWriting = true;
        }
      }
      expect(sawReady).toBe(true);
      expect(sawTempWriting).toBe(true);

      proc.kill();
      await proc.exited;

      // 不是重建对象读已保存快照：子进程真的死在写入阶段，这里校验落盘文件是否完整。
      const parsed = JSON.parse(readFileSync(file, "utf8")) as OutboxSnapshot;
      expect(parsed.seq).toBe(0);
      const dispatched: string[] = [];
      const effects = createDurableEffects(
        async (intent) => {
          dispatched.push(intent.key);
          return "ok";
        },
        { journal: createFileDurableJournal(file) }
      );
      expect(effects.recover()).toMatchObject({ restored: true, pending: 1, receipts: 1 });
      expect(await effects.commit()).toHaveLength(1);
      expect(dispatched).toEqual(["pending-0"]);
    } finally {
      try {
        proc.kill();
        await proc.exited.catch(() => {});
      } catch {
        // 子进程可能已退出。
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("T-14 未知结果不盲目重放", () => {
  test("recover 后 unknown 意图留在队列但不进入派发集合", async () => {
    const dispatched: string[] = [];
    const effects = createDurableEffects((intent) => {
      dispatched.push(intent.key);
      return "ok";
    });
    effects.enqueue("message", "m1", "x");
    expect(effects.pending()).toHaveLength(1);
    expect(effects.dispatchable()).toHaveLength(1);
    expect(effects.unknownIntents()).toEqual([]);
    expect(await effects.commit()).toHaveLength(1);
    expect(dispatched).toEqual(["m1"]);
  });
});
