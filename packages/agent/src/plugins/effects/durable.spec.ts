import { describe, expect, test } from "bun:test";
import { createDurableEffects, createStepLedger, replayToolCall, type AgentTool } from "./durable";

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
