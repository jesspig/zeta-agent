/** RED-10： durable journal 非幂等重复副作用——同一 dispatching 意图可被重复 settle 产生多份回执。 */
import {
  createInMemoryOutboxJournal,
  createPersistentOutbox,
} from "../../packages/components/security/src/outbox.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/components/security/src/outbox.ts:finish/settle（不校验 entry 是否仍为当前 dispatching 代次，" +
  "重复 settle 会再推一条 receipt，造成重复计费/重复可观察副作用）";

export default {
  id: "RED-10-durable-idempotent-settle",
  title: "durable journal 幂等交付：同一意图重复 settle 不得产生第二份回执",
  expectation:
    "一次 dispatching 意图只能落一份真实回执；对同一 entry 重复调用 settle（例如崩溃恢复后重复确认）必须被拒绝或幂等返回同一回执，receipts 数仍为 1，不重复计费",
  target: "AC-14",
  async probe() {
    const outbox = createPersistentOutbox({ journal: createInMemoryOutboxJournal() });
    const entry = outbox.enqueue("message", "m1", "hello");
    const started = outbox.beginDispatch(entry);
    const first = outbox.settle(started, true, "first");

    let duplicate;
    let duplicateError = "";
    try {
      duplicate = outbox.settle(started, true, "second");
    } catch (error) {
      duplicateError = error instanceof Error ? error.message : String(error);
    }
    const receipts = outbox.receipts();
    const actual = {
      first,
      duplicate,
      duplicateError,
      receipts,
      receiptCount: receipts.length,
      pendingCount: outbox.entries().length,
    };
    const idempotent =
      receipts.length === 1 &&
      receipts[0]?.value === "first" &&
      duplicate === undefined &&
      duplicateError.includes("OUTBOX");
    return idempotent
      ? green(actual, "outbox 按 (seq,generation) 拒收陈旧 settle + 原子 journal")
      : red(
          actual,
          `同一 dispatching 意图被重复 settle：receipts 数=${receipts.length}（应为 1），` +
            (duplicate === undefined
              ? "重复 settle 未被显式拒绝"
              : `重复 settle 返回了第二份回执 ${JSON.stringify(duplicate)}`),
          EVIDENCE
        );
  },
};
