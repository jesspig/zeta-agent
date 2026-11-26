import { describe, expect, test } from "bun:test";
import {
  createInMemoryOutboxJournal,
  createPersistentOutbox,
} from "./outbox";
import { DURABLE_UNKNOWN_VOCABULARY, describeUnknownOutcome } from "./durable-vocabulary";

describe("T-14/T-17 unknown 词汇统一", () => {
  test("outbox 的 unknown 状态与共享词汇表同一术语", () => {
    const outbox = createPersistentOutbox({ journal: createInMemoryOutboxJournal() });
    const entry = outbox.enqueue("message", "k1", "payload");
    outbox.beginDispatch(entry);
    // 用 journal 快照模拟 dispatching 未 settle 的崩溃恢复。
    const journal = createInMemoryOutboxJournal();
    journal.save({
      schemaVersion: 1,
      seq: 1,
      pending: [{ ...entry, state: "dispatching" }],
      receipts: [],
      seen: [],
      revision: 1,
      consecutiveFailures: 0,
    } as Parameters<typeof journal.save>[0]);
    const restored = createPersistentOutbox({ journal });
    expect(restored.unknown().map((item) => item.state)).toEqual([DURABLE_UNKNOWN_VOCABULARY.unknown]);
  });

  test("统一文案只承诺 at-least-once + 幂等 adapter + unknown 对账", () => {
    const text = describeUnknownOutcome("写入结果不确定");
    expect(text).toContain(DURABLE_UNKNOWN_VOCABULARY.unknown);
    expect(text).toContain(DURABLE_UNKNOWN_VOCABULARY.delivery);
    expect(text).toContain(DURABLE_UNKNOWN_VOCABULARY.adapter);
    expect(text).toContain(DURABLE_UNKNOWN_VOCABULARY.reconciliation);
    expect(text).toContain(DURABLE_UNKNOWN_VOCABULARY.forbiddenClaim);
    expect(DURABLE_UNKNOWN_VOCABULARY.sessionUnknown).toContain(DURABLE_UNKNOWN_VOCABULARY.unknown);
  });
});
