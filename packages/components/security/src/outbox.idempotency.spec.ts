import { describe, expect, test } from "bun:test";
import {
  createInMemoryOutboxJournal,
  createPersistentOutbox,
  OUTBOX_SCHEMA_VERSION,
  type OutboxSnapshot,
} from "./outbox";

describe("T-14 调用级幂等 / schemaVersion 只读兼容", () => {
  test("重复 settle 与陈旧 generation 确认都被拒绝，回执与计费只发生一次", () => {
    const outbox = createPersistentOutbox({ journal: createInMemoryOutboxJournal() });
    const started = outbox.beginDispatch(outbox.enqueue("message", "m1", "hello"));
    const receipt = outbox.settle(started, true, "first");
    expect(() => outbox.settle(started, true, "second")).toThrow("OUTBOX_NOT_DISPATCHABLE");
    expect(() => outbox.fail(started)).toThrow("OUTBOX_NOT_DISPATCHABLE");
    expect(outbox.receipts()).toEqual([receipt]);
    expect(outbox.receipts()).toHaveLength(1);

    const next = outbox.beginDispatch(outbox.enqueue("message", "m2", "hello"));
    expect(() => outbox.settle({ ...started, seq: next.seq }, true, "stale")).toThrow("OUTBOX_NOT_DISPATCHABLE");
    expect(outbox.receipts()).toHaveLength(1);
  });

  test("历史快照（无 schemaVersion、receipt 无新字段）只读兼容，不被回写伪造", () => {
    const journal = createInMemoryOutboxJournal();
    const historical = {
      seq: 1,
      pending: [],
      receipts: [{ kind: "message", key: "legacy", ok: true, value: "legacy-value" }],
      seen: ["message\u0000legacy"],
      revision: 3,
      consecutiveFailures: 0,
    } as OutboxSnapshot;
    journal.save(historical);

    const outbox = createPersistentOutbox({ journal });
    expect(outbox.recover()).toMatchObject({ restored: true, receipts: 1 });
    expect(outbox.receipts()).toEqual(historical.receipts);
    const started = outbox.beginDispatch(outbox.enqueue("message", "m2", "hello"));
    outbox.settle(started, true, "new");
    const persisted = journal.load() as OutboxSnapshot;
    expect(persisted.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
    expect(persisted.receipts[0]).toEqual(historical.receipts[0]);
    expect(persisted.receipts[1]).toMatchObject({ key: "m2", idempotencyKey: "message\u0000m2", generation: 1 });
  });

  test("未来 schemaVersion 失败关闭，不把未知格式当作当前格式读取", () => {
    const journal = createInMemoryOutboxJournal();
    journal.save({
      schemaVersion: OUTBOX_SCHEMA_VERSION + 1,
      seq: 0,
      pending: [],
      receipts: [],
      seen: [],
      revision: 0,
      consecutiveFailures: 0,
    });
    expect(() => createPersistentOutbox({ journal })).toThrow("OUTBOX_SCHEMA_UNSUPPORTED");
  });

  test("显式领域键跨重启稳定：重复 enqueue 命中历史真实回执，不再派发", () => {
    const journal = createInMemoryOutboxJournal();
    const first = createPersistentOutbox({ journal });
    const started = first.beginDispatch(first.enqueue("message", "domain-key-1", "payload"));
    const receipt = first.settle(started, true, "real-value");

    const restarted = createPersistentOutbox({ journal });
    const duplicate = restarted.enqueue("message", "domain-key-1", "payload");
    expect(duplicate).toMatchObject({
      key: "domain-key-1",
      idempotencyKey: "message\u0000domain-key-1",
      state: "settled",
      generation: receipt.generation,
    });
    expect(restarted.dispatchable()).toEqual([]);
    expect(restarted.receipts()).toEqual([receipt]);
  });
});
