import { describe, expect, test } from "bun:test";
import type { AgentMessage, SemanticRecap } from "@zeta-agent/agent-framework";
import {
  DURABLE_UNKNOWN_VOCABULARY,
  SESSION_STORE_VERSION,
  type SessionStore,
  type SessionStoreFaults,
} from "./store";

export interface ConformanceFactoryOptions {
  readonly sessionId?: string;
  readonly faults?: SessionStoreFaults;
  /** 独立目的地；后端据此创建另一个存储文件。 */
  readonly destination?: string;
  /** 跨 writer 竞争用例：分区进程内锁，仅靠文件/库租约裁决唯一写入者。 */
  readonly writerId?: string;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
}

export interface ConformanceFactory {
  (options?: ConformanceFactoryOptions): SessionStore;
  /** 当前用例的独立 clone 目的地。 */
  destination(): string;
  /** 按后端写入一个坏 frame（坏行/坏 payload），验证失败关闭语义。 */
  seedBadFrame(): void;
}

function message(content: string): AgentMessage {
  return { role: "user", content };
}

function recap(text: string): SemanticRecap {
  return {
    objective: text,
    establishedFacts: [],
    appliedChanges: [],
    verification: [],
    deadEnds: [],
    remainingPlan: [],
  };
}

/** 故障注入：只在第 nth 次调用触发，恢复后写入应能继续。 */
export function failOnNth<T extends (...args: never[]) => unknown>(fn: T, nth = 1): T {
  let calls = 0;
  return ((...args: Parameters<T>) => {
    calls += 1;
    if (calls !== nth) return undefined as ReturnType<T>;
    return fn(...args);
  }) as T;
}

/**
 * JSONL 与 SQLite 共同遵守的 SessionStore 契约。
 * 两个后端用同一组用例验证 header/version、append/projection、fork/resume/
 * truncate/clone、租约、两类崩溃窗口、未知结果恢复与并发 append。
 */
export function runSessionStoreConformance(name: string, factory: ConformanceFactory): void {
  describe(`T-11 ${name} SessionStore conformance`, () => {
    test("header/version 与 append/projection/reopen", async () => {
      const store = factory({ sessionId: "conformance-1" });
      expect(store.header.sessionId).toBe("conformance-1");
      expect(store.version).toBe(SESSION_STORE_VERSION);
      expect(store.state).toBe("ready");

      const first = await store.append(message("one"));
      const second = await store.append({ role: "assistant", content: "two" });
      expect(first.outcome).toBe("committed");
      expect(second.seq).toBe(first.seq + 1);
      expect(store.projection().messages.map((item) => item.content)).toEqual(["one", "two"]);
      expect(store.projection().leafId).toBe(second.frameId);

      const reopened = factory();
      expect(reopened.projection().messages.map((item) => item.content)).toEqual(["one", "two"]);
      expect(reopened.projection().leafId).toBe(second.frameId);
      store.close();
      reopened.close();
    });

    test("fork marker 独立 kind，不污染 lineage，分支互不串", async () => {
      const store = factory();
      const root = await store.append(message("root"));
      const forkView = await store.fork(root.frameId);
      const forkId = forkView.projection().leafId;
      expect(forkId).not.toBe(root.frameId);
      const marker = forkView.projection().frames.find((frame) => frame.id === forkId);
      expect(marker?.kind).toBe("fork");
      expect(store.projection().lineage).toEqual([]);

      await forkView.append(message("branch"));
      const main = await store.append(message("main"));
      expect(store.projection().branch.map((frame) => frame.id)).toEqual([root.frameId, main.frameId]);
      expect(forkView.projection().branch.map((frame) => frame.id)).toEqual([
        root.frameId,
        forkId!,
        forkView.projection().leafId!,
      ]);
      expect(store.projection().lineage).toEqual([]);
      expect(forkView.projection().lineage).toEqual([]);
      store.close();
      forkView.close();
    });

    test("recap lineage 与 fork marker 分离", async () => {
      const store = factory();
      await store.append(message("before"));
      await store.appendRecap(recap("summary"), ["zeta://a"], { threshold: 7, preTokenCount: 42 });
      expect(store.projection().lineage).toHaveLength(1);
      expect(store.projection().lineage[0]?.threshold).toBe(7);
      expect(store.projection().messages.map((item) => item.content)).toEqual(["before"]);

      const resumed = store.resume(store.projection().frames[0]!.id);
      await resumed.fork();
      expect(resumed.projection().lineage).toHaveLength(1);
      store.close();
      resumed.close();
    });

    test("resume/truncate 保留不可变 frame 并切换活跃分支", async () => {
      const store = factory();
      const first = await store.append(message("a"));
      await store.append(message("b"));
      await store.append(message("c"));

      const resumed = store.resume(first.frameId);
      expect(resumed.projection().messages.map((item) => item.content)).toEqual(["a"]);

      const truncated = await store.truncate(first.frameId);
      const marker = truncated.projection().frames.find((frame) => frame.id === truncated.projection().leafId);
      expect(marker?.kind).toBe("truncate");
      expect(truncated.projection().messages.map((item) => item.content)).toEqual(["a"]);
      expect(store.projection().frames).toHaveLength(4);

      const reopened = factory();
      expect(reopened.projection().messages.map((item) => item.content)).toEqual(["a"]);
      expect(reopened.projection().frames).toHaveLength(4);
      store.close();
      resumed.close();
      truncated.close();
      reopened.close();
    });

    test("clone 生成独立存储且保留消息与拓扑", async () => {
      const store = factory();
      const first = await store.append(message("clone-a"));
      const second = await store.append(message("clone-b"));
      const cloned = store.clone(factory.destination());
      expect(cloned.projection().messages.map((item) => item.content)).toEqual(["clone-a", "clone-b"]);
      expect(cloned.projection().frames.map((frame) => frame.id)).not.toEqual([
        first.frameId,
        second.frameId,
      ]);
      expect(cloned.projection().frames[1]?.parentId).toBe(cloned.projection().frames[0]?.id);
      await cloned.append(message("clone-only"));
      expect(store.projection().messages.map((item) => item.content)).toEqual(["clone-a", "clone-b"]);
      store.close();
      cloned.close();
    });

    test("提交前崩溃窗口：retryable 不落 frame，可立即重试", async () => {
      const store = factory({
        faults: {
          beforeCommit: failOnNth(() => {
            throw new Error("crash-before-commit");
          }),
        },
      });
      await expect(store.append(message("lost"))).rejects.toMatchObject({
        code: "SESSION_RETRYABLE",
      });
      expect(store.state).toBe("ready");
      expect(store.projection().messages).toEqual([]);
      const recovery = await store.recover();
      expect(recovery.retryable).toHaveLength(1);
      const retried = await store.append(message("kept"));
      expect(retried.outcome).toBe("committed");
      expect(store.projection().messages.map((item) => item.content)).toEqual(["kept"]);
      store.close();
    });

    test("提交后崩溃窗口：unknown-outcome 停止写入，重开后恢复不重复", async () => {
      const store = factory({
        faults: {
          afterCommit: failOnNth(() => {
            throw new Error("crash-after-commit");
          }, 2),
        },
      });
      await store.append(message("first"));
      await expect(store.append(message("uncertain"))).rejects.toMatchObject({
        code: "SESSION_UNKNOWN_OUTCOME",
      });
      expect(store.state).toBe("unknown-outcome");
      expect(store.projection().messages.map((item) => item.content)).toEqual(["first", "uncertain"]);
      await expect(store.append(message("blocked"))).rejects.toMatchObject({
        code: "SESSION_STATE_UNKNOWN_OUTCOME",
      });

      const reopened = factory();
      expect(reopened.state).toBe("unknown-outcome");
      await expect(reopened.append(message("blocked-again"))).rejects.toMatchObject({
        code: "SESSION_STATE_UNKNOWN_OUTCOME",
      });
      const recovery = await reopened.recover();
      expect(recovery.committed).toHaveLength(1);
      expect(reopened.state).toBe("ready");
      const after = await reopened.append(message("after"));
      expect(after.outcome).toBe("committed");
      expect(reopened.projection().messages.map((item) => item.content)).toEqual([
        "first",
        "uncertain",
        "after",
      ]);
      expect(store.projection().frames).toHaveLength(3);
      store.close();
      reopened.close();
    });

    test("并发 append 无丢帧，seq 唯一且重开一致", async () => {
      const store = factory();
      const receipts = await Promise.all(
        Array.from({ length: 8 }, (_, index) => store.append(message(`m${index}`)))
      );
      expect(new Set(receipts.map((receipt) => receipt.seq)).size).toBe(8);
      expect(store.projection().messages).toHaveLength(8);
      const reopened = factory();
      expect(reopened.projection().messages).toHaveLength(8);
      expect(reopened.projection().messages.map((item) => item.content).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `m${index}`).sort()
      );
      store.close();
      reopened.close();
    });

    test("提交中崩溃窗口：unknown-outcome 停止写入，重开 recover 可对账", async () => {
      const store = factory({
        faults: {
          duringCommit: failOnNth(() => {
            throw new Error("crash-during-commit");
          }),
        },
      });
      await expect(store.append(message("uncertain"))).rejects.toMatchObject({
        code: "SESSION_UNKNOWN_OUTCOME",
      });
      expect(store.state).toBe(DURABLE_UNKNOWN_VOCABULARY.sessionUnknown);
      expect(store.projection().messages).toEqual([]);
      expect(store.pendingIntents()).toHaveLength(1);
      await expect(store.append(message("blocked"))).rejects.toMatchObject({
        code: "SESSION_STATE_UNKNOWN_OUTCOME",
      });

      const reopened = factory();
      expect(reopened.state).toBe(DURABLE_UNKNOWN_VOCABULARY.sessionUnknown);
      const recovery = await reopened.recover();
      expect(recovery.committed).toHaveLength(0);
      expect(recovery.retryable).toHaveLength(1);
      expect(reopened.state).toBe("ready");
      const after = await reopened.append(message("after"));
      expect(after.outcome).toBe("committed");
      expect(reopened.projection().messages.map((item) => item.content)).toEqual(["after"]);
      store.close();
      reopened.close();
    });

    test("坏 frame 强制 readonly，不静默跳过也不由 recover 抹除", async () => {
      const store = factory();
      await store.append(message("before"));
      factory.seedBadFrame();
      expect(store.state).toBe("readonly");
      expect(store.projection().badLines).toBeGreaterThan(0);
      await expect(store.append(message("blocked"))).rejects.toMatchObject({ code: "SESSION_READONLY" });
      const recovery = await store.recover();
      expect(recovery.state).toBe("readonly");
      expect(recovery.badLines).toBeGreaterThan(0);
      expect(store.projection().messages.map((item) => item.content)).toEqual(["before"]);
      store.close();
    });

    test("CAS 租约跨 writer 唯一：过期接管后旧 writer 迟到 release 不删新租约", async () => {
      const clock = { now: 1_000_000 };
      const shared = { now: () => clock.now, leaseTtlMs: 100, retryMs: 30 };
      let releaseA!: () => void;
      let releaseB!: () => void;
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      let aReady!: () => void;
      let bReady!: () => void;
      const readyA = new Promise<void>((resolve) => { aReady = resolve; });
      const readyB = new Promise<void>((resolve) => { bReady = resolve; });
      const a = factory({ ...shared, sessionId: "cas-a", leaseOwner: "writer-A", writerId: "A", faults: { afterLeaseAcquire: async () => { aReady(); await gateA; } } });
      const b = factory({ ...shared, sessionId: "cas-b", leaseOwner: "writer-B", writerId: "B", faults: { afterLeaseAcquire: async () => { bReady(); await gateB; } } });
      const c = factory({ ...shared, sessionId: "cas-c", leaseOwner: "writer-C", writerId: "C" });

      const aAppend = a.append(message("A"));
      await readyA;
      expect(a.lease()?.owner).toBe("writer-A");
      clock.now += 101;
      const bAppend = b.append(message("B"));
      await readyB;
      expect(b.lease()?.owner).toBe("writer-B");

      releaseA();
      await aAppend;
      expect(b.lease()?.owner).toBe("writer-B");
      await expect(c.append(message("C"))).rejects.toMatchObject({ code: "SESSION_LEASE_BUSY" });
      releaseB();
      await bAppend;
      expect(new Set([...a.projection().messages, ...b.projection().messages].map((item) => item.content))).toEqual(
        new Set(["A", "B"])
      );
      a.close();
      b.close();
      c.close();
    });

    test("unknown 词汇与 T-14 durable journal 一致，且禁止 exactly-once 措辞", async () => {
      const store = factory({
        faults: {
          afterCommit: failOnNth(() => {
            throw new Error("crash-after-commit");
          }, 2),
        },
      });
      await store.append(message("first"));
      await expect(store.append(message("uncertain"))).rejects.toMatchObject({
        code: "SESSION_UNKNOWN_OUTCOME",
      });
      let messageText = "";
      try {
        await store.append(message("blocked"));
      } catch (error) {
        messageText = error instanceof Error ? error.message : String(error);
      }
      expect(DURABLE_UNKNOWN_VOCABULARY.unknown).toBe("unknown");
      expect(DURABLE_UNKNOWN_VOCABULARY.sessionUnknown).toContain(DURABLE_UNKNOWN_VOCABULARY.unknown);
      expect(messageText).toContain(DURABLE_UNKNOWN_VOCABULARY.unknown);
      expect(messageText).toContain(DURABLE_UNKNOWN_VOCABULARY.delivery);
      expect(messageText).toContain(DURABLE_UNKNOWN_VOCABULARY.reconciliation);
      expect(messageText).toContain(DURABLE_UNKNOWN_VOCABULARY.forbiddenClaim);
      const recovery = await store.recover();
      expect(recovery.state).toBe("ready");
      store.close();
    });
  });
}
