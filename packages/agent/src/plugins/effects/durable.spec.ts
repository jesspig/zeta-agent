import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableEffects,
  createFileDurableJournal,
  createStepLedger,
  replayToolCall,
  type AgentTool,
} from "./durable";

describe("T-24 durable effects and replay semantics", () => {
  test("replay never reuses verified facts without re-executing", async () => {
    let calls = 0;
    const tool: AgentTool<string> = {
      name: "send",
      replay: "never",
      execute: () => {
        calls += 1;
        return "side-effect";
      },
    };

    const outcome = await replayToolCall({
      tool,
      stepKey: "step-1",
      input: "payload",
      ledger: createStepLedger(),
      recorded: "verified-send-fact",
    });

    expect(calls).toBe(0);
    expect(outcome.action).toBe("verified-fact");
    expect(outcome.value).toBe("verified-send-fact");

    let message = "";
    try {
      await replayToolCall({ tool, stepKey: "step-2", input: "x", ledger: createStepLedger() });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("verified fact");
  });

  test("replay safe rebuilds idempotently with stepKey dedup", async () => {
    let calls = 0;
    const tool: AgentTool<number> = {
      name: "compute",
      replay: "safe",
      execute: (input) => {
        calls += 1;
        return input * 2;
      },
    };
    const ledger = createStepLedger();

    const first = await replayToolCall({ tool, stepKey: "same-step", input: 21, ledger });
    const second = await replayToolCall({ tool, stepKey: "same-step", input: 21, ledger });

    expect(calls).toBe(1);
    expect(first).toEqual({ action: "replayed", value: 42 });
    expect(second).toEqual({ action: "replayed", value: 42 });
  });

  test("stepKey dedup returns recorded result and skips work", async () => {
    const ledger = createStepLedger();
    let runs = 0;

    const first = await ledger.step("k", () => {
      runs += 1;
      return "done";
    });
    const second = await ledger.step("k", () => {
      runs += 1;
      return "other";
    });

    expect(first).toEqual({ value: "done", created: true });
    expect(second).toEqual({ value: "done", created: false });
    expect(runs).toBe(1);
    expect(ledger.has("k")).toBe(true);
    expect(() => ledger.step("", () => 1)).toThrow();
  });

  test("withhold effects enqueue in transaction and dispatch only after commit", async () => {
    const dispatched: string[] = [];
    const effects = createDurableEffects(async (intent) => {
      dispatched.push(`${intent.kind}:${intent.key}:${intent.payload}`);
      return "ok";
    });

    effects.enqueue("message", "m1", "hello");
    effects.enqueue("message", "m1", "duplicate");
    effects.enqueue("file", "f1", "data");

    expect(dispatched).toEqual([]);
    expect(effects.pending().map((intent) => intent.key)).toEqual(["m1", "f1"]);
    expect(effects.pending().map((intent) => intent.seq)).toEqual([1, 2]);

    const receipts = await effects.commit();

    expect(dispatched).toEqual(["message:m1:hello", "file:f1:data"]);
    expect(receipts).toEqual([
      { kind: "message", key: "m1", ok: true, value: "ok" },
      { kind: "file", key: "f1", ok: true, value: "ok" },
    ]);
    expect(effects.pending()).toEqual([]);
    expect(effects.receipts()).toHaveLength(2);
    expect(() => effects.enqueue("", "k", 1)).toThrow();
  });

  test("safe tool that cannot be reconstructed falls back to verified facts", async () => {
    let calls = 0;
    const tool: AgentTool<string> = {
      name: "write",
      replay: "safe",
      execute: () => {
        calls += 1;
        return "written";
      },
    };

    const outcome = await replayToolCall({
      tool,
      stepKey: "step-x",
      input: "x",
      ledger: createStepLedger(),
      recorded: "written-fact",
      canReconstruct: false,
    });

    expect(calls).toBe(0);
    expect(outcome).toEqual({ action: "verified-fact", value: "written-fact" });
  });
});

describe("A15 durable outbox/journal 崩溃重启恢复", () => {
  test("显式注入文件 journal：重启后重放 pending，幂等键不产生重复派发", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-durable-"));
    const file = join(dir, "outbox.json");
    try {
      const dispatched: string[] = [];
      const dispatch = async (intent: { seq: number; kind: string; key: string }) => {
        dispatched.push(`${intent.seq}:${intent.kind}:${intent.key}`);
        return "ok";
      };

      const first = createDurableEffects(dispatch, { journal: createFileDurableJournal(file) });
      first.enqueue("message", "m1", { text: "hello" });
      first.enqueue("message", "m1", { text: "duplicate" });
      first.enqueue("file", "f1", "data");
      expect(first.pending().map((intent) => intent.seq)).toEqual([1, 2]);
      expect(existsSync(file)).toBe(true);

      // 模拟进程崩溃：pending 未 commit，下一进程用同一 journal 恢复。
      const restarted = createDurableEffects(dispatch, { journal: createFileDurableJournal(file) });
      const recovered = restarted.recover();
      expect(recovered).toEqual({ restored: true, pending: 2, receipts: 0 });
      expect(restarted.pending().map((intent) => intent.key)).toEqual(["m1", "f1"]);

      const receipts = await restarted.commit();
      expect(receipts.map((receipt) => receipt.key)).toEqual(["m1", "f1"]);
      expect(dispatched).toEqual(["1:message:m1", "2:file:f1"]);

      // 二次重启：回执保留，重复幂等键不再入队也不再派发。
      const again = createDurableEffects(dispatch, { journal: createFileDurableJournal(file) });
      expect(again.recover()).toEqual({ restored: true, pending: 0, receipts: 2 });
      again.enqueue("message", "m1", { text: "again" });
      again.enqueue("file", "f1", "again");
      expect(again.pending()).toEqual([]);
      expect(await again.commit()).toEqual([]);
      expect(dispatched).toEqual(["1:message:m1", "2:file:f1"]);
      expect(again.receipts()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("默认内存 journal 不落盘，实例之间状态隔离", () => {
    const fresh = createDurableEffects(() => 1);
    expect(fresh.recover()).toEqual({ restored: false, pending: 0, receipts: 0 });

    const one = createDurableEffects(() => 1);
    one.enqueue("message", "m1", "hello");
    expect(one.pending()).toHaveLength(1);

    const other = createDurableEffects(() => 1);
    expect(other.pending()).toEqual([]);
    expect(other.receipts()).toEqual([]);
  });
});
