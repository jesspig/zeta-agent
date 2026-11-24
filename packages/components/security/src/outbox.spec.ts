import { describe, expect, test } from "bun:test";
import {
  createInMemoryOutboxJournal,
  createPersistentOutbox,
  type OutboxJournal,
} from "./outbox";

function journal(): OutboxJournal {
  return createInMemoryOutboxJournal();
}

describe("T-14 持久 outbox 状态机", () => {
  test("(kind,key) 幂等去重，seq 连续，idempotencyKey 贯穿各代", () => {
    const store = createPersistentOutbox({ journal: journal() });
    const first = store.enqueue("message", "m1", { text: "hello" });
    expect(store.enqueue("message", "m1", { text: "duplicate" })).toEqual(first);
    const second = store.enqueue("file", "f1", "data");
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.idempotencyKey).toBe("message\u0000m1");
    expect(first.state).toBe("queued");
    expect(first.generation).toBe(0);
    expect(store.entries()).toHaveLength(2);
  });

  test("派发生命周期：queued → dispatching → settled，generation 递增且回执落盘", () => {
    const store = createPersistentOutbox({ journal: journal() });
    const entry = store.enqueue("message", "m1", "hello");
    const started = store.beginDispatch(entry);
    expect(started.state).toBe("dispatching");
    expect(started.generation).toBe(1);
    const receipt = store.settle(started, true, "ok");
    expect(receipt).toEqual({ kind: "message", key: "m1", ok: true, value: "ok" });
    expect(store.entries()).toEqual([]);
    expect(store.receipts()).toEqual([receipt]);
  });

  test("崩溃窗口一：commit 前重启，pending 保留且按同一幂等键派发", () => {
    const shared = journal();
    const first = createPersistentOutbox({ journal: shared });
    const entry = first.enqueue("message", "m1", "hello");
    expect(entry.seq).toBe(1);

    const restarted = createPersistentOutbox({ journal: shared });
    const recovered = restarted.recover();
    expect(recovered).toMatchObject({ restored: true, pending: 1, receipts: 0, unknown: 0 });
    expect(restarted.entries()[0]!.idempotencyKey).toBe(entry.idempotencyKey);
    expect(restarted.entries()[0]!.state).toBe("queued");
  });

  test("崩溃窗口二：dispatch 成功后回执落盘前重启，标记 unknown 且不再自动重放", () => {
    const shared = journal();
    const first = createPersistentOutbox({ journal: shared });
    const entry = first.enqueue("message", "m1", "hello");
    first.beginDispatch(entry);

    const restarted = createPersistentOutbox({ journal: shared });
    const recovered = restarted.recover();
    expect(recovered).toMatchObject({ restored: true, pending: 1, receipts: 0, unknown: 1 });
    expect(restarted.entries()[0]!.state).toBe("unknown");
    expect(restarted.dispatchable()).toEqual([]);
    const receipt = restarted.reconcile("m1", true, "manual-ok");
    expect(receipt).toEqual({ kind: "message", key: "m1", ok: true, value: "manual-ok" });
    expect(restarted.dispatchable()).toEqual([]);
    expect(restarted.receipts()).toEqual([receipt]);
  });

  test("失败重试与 health：达到重试上限记失败回执，连续失败触发 health error", () => {
    const store = createPersistentOutbox({ journal: journal(), maxAttempts: 2, healthThreshold: 2 });
    let entry = store.enqueue("message", "m1", "hello");
    entry = store.beginDispatch(entry);
    const retry = store.fail(entry);
    expect(retry.retry).toBe(true);
    if (retry.retry) expect(retry.entry.state).toBe("queued");
    expect(store.entries()[0]!.generation).toBe(2);

    entry = store.beginDispatch(store.entries()[0]!);
    const terminal = store.fail(entry);
    expect(terminal.retry).toBe(false);
    if (!terminal.retry) expect(terminal.receipt).toEqual({ kind: "message", key: "m1", ok: false });
    expect(store.health()).toMatchObject({ ok: true, consecutiveFailures: 1 });

    const second = store.beginDispatch(store.enqueue("message", "m2", "x"));
    store.fail(second);
    const last = store.beginDispatch(store.entries()[0]!);
    store.fail(last);
    expect(store.health()).toMatchObject({ ok: false, consecutiveFailures: 2 });
    store.resetHealth();
    expect(store.health().ok).toBe(true);
  });

  test("Later 不算失败：延后项不进 health，retryDeferred 后重新可派发", () => {
    let now = 0;
    const store = createPersistentOutbox({ journal: journal(), now: () => now });
    const entry = store.enqueue("message", "m1", "hello");
    const deferred = store.later(store.beginDispatch(entry), 50);
    expect(deferred.state).toBe("deferred");
    expect(deferred.generation).toBe(1);
    expect(store.health()).toMatchObject({ ok: true, consecutiveFailures: 0 });
    expect(store.dispatchable()).toEqual([]);

    now = 49;
    store.retryDeferred();
    expect(store.dispatchable()).toEqual([]);
    now = 50;
    store.retryDeferred();
    expect(store.dispatchable()).toHaveLength(1);
    expect(store.dispatchable()[0]!.state).toBe("queued");
  });
});
