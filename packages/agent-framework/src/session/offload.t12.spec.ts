import { describe, expect, test } from "bun:test";
import { createSessionSurface, type SurfaceEntry } from "./surface";
import type { CompactionEvent } from "./offload";
import {
  CompactionInterruptedError,
  CompactionOverflowError,
  createBudgetTracker,
  createCompactionListener,
  createMemoryWorkspaceStore,
  createOffloader,
  safeCutIndex,
} from "./offload";

const entry = (content: string): SurfaceEntry => ({ kind: "message", message: { role: "user", content } });
const RECAP = {
  objective: "recovered",
  establishedFacts: [],
  appliedChanges: [],
  verification: [],
  deadEnds: [],
  remainingPlan: [],
} as const;
const buildRecap = () => ({ ...RECAP, establishedFacts: [], appliedChanges: [], verification: [], deadEnds: [], remainingPlan: [] });

function fixture(): ReturnType<typeof createSessionSurface> {
  const surface = createSessionSurface();
  surface.append({ role: "system", content: "objective" });
  surface.append({ role: "user", content: "question" });
  surface.append({ role: "assistant", content: "answer" });
  return surface;
}

describe("T-12 Offloader 输出字节上限", () => {
  test("offload 按完整条目裁剪到 maxOutputBytes，retrieve 可再次限量", async () => {
    const store = createMemoryWorkspaceStore();
    const offloader = createOffloader(store, { maxOutputBytes: 40 });
    const block = [entry("x".repeat(20)), entry("y".repeat(20)), entry("z".repeat(20))];
    const uri = await offloader.offload(block, "block");
    const stored = await offloader.retrieve<SurfaceEntry[]>(uri);
    expect(stored!.length).toBeLessThan(block.length);
    expect(JSON.stringify(stored!).length).toBeLessThanOrEqual(80);
    const bounded = await offloader.retrieve<SurfaceEntry[]>(uri, 1);
    expect(bounded!.length).toBeLessThanOrEqual(stored!.length);
  });
});

describe("T-12 压缩事件、usage 与 peak", () => {
  test("completed 事件带 usage（含 peak）并纳入 agent_end 屏障", async () => {
    const surface = fixture();
    const events: CompactionEvent[] = [];
    const tracker = createBudgetTracker({ totalContextLimit: 1000, compactionThreshold: 20 });
    let persisted = false;
    const listener = createCompactionListener({
      budget: { totalContextLimit: 1000, compactionThreshold: 20 },
      surface,
      offloader: createOffloader(createMemoryWorkspaceStore()),
      countTokens: () => 30,
      buildRecap,
      budgetTracker: tracker,
      emit: (event) => { events.push(event); },
      persist: async () => { await Promise.resolve(); persisted = true; },
    });
    await listener({ type: "agent_end", messages: [] });
    expect(persisted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["compaction_started", "compaction_completed"]);
    const completed = events[1];
    expect(completed?.type).toBe("compaction_completed");
    if (completed?.type !== "compaction_completed") return;
    expect(completed.usage.peakTokens).toBeGreaterThanOrEqual(30);
    expect(completed.usage.compactionCount).toBe(1);
    expect(completed.usage.totalTokens).toBe(completed.usage.inputTokens + completed.usage.outputTokens);
  });

  test("offload 失败保留旧上下文并发出 failed 事件", async () => {
    const surface = fixture();
    const before = surface.entries();
    const events: CompactionEvent[] = [];
    const listener = createCompactionListener({
      budget: { totalContextLimit: 1000, compactionThreshold: 20 },
      surface,
      offloader: {
        offload: async () => { throw new Error("offload-down"); },
        retrieve: async () => undefined,
      },
      countTokens: () => 30,
      buildRecap,
      emit: (event) => { events.push(event); },
      persist: () => { throw new Error("persist must not run"); },
    });
    let message = "";
    try {
      await listener({ type: "agent_end", messages: [] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("offload-down");
    expect(surface.entries()).toEqual(before);
    expect(surface.lineage()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["compaction_started", "compaction_failed"]);
    const failed = events[1];
    if (failed?.type === "compaction_failed") expect(failed.reason).toContain("offload-down");
  });

  test("超限仅恢复一次：恢复后仍超限抛 typed OVERFLOW，且保留旧上下文", async () => {
    const surface = fixture();
    const before = surface.entries();
    let offloadCalls = 0;
    const listener = createCompactionListener({
      budget: { totalContextLimit: 50, compactionThreshold: 20 },
      surface,
      offloader: {
        offload: async (block) => { offloadCalls += 1; return `workspace:///o${offloadCalls}`; },
        retrieve: async () => undefined,
      },
      countTokens: () => 51,
      buildRecap,
      persist: () => { throw new Error("persist must not run"); },
    });
    let error: unknown;
    try {
      await listener({ type: "agent_end", messages: [] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompactionOverflowError);
    expect((error as { code?: string }).code).toBe("OVERFLOW_UNRECOVERABLE");
    expect(offloadCalls).toBe(1);
    expect(surface.entries()).toEqual(before);
  });

  test("超限恢复一次后降到阈值以下则成功", async () => {
    const surface = fixture();
    let calls = 0;
    const listener = createCompactionListener({
      budget: { totalContextLimit: 100, compactionThreshold: 20 },
      surface,
      offloader: { offload: async () => "workspace:///ok", retrieve: async () => undefined },
      countTokens: (entries) => { calls += 1; return calls === 1 ? 60 : 10; },
      buildRecap,
      persist: () => {},
    });
    await listener({ type: "agent_end", messages: [] });
    expect(surface.entries()[0]?.kind).toBe("recap");
    expect(calls).toBe(2);
  });

  test("abort 信号触发 interrupted 且不改动上下文", async () => {
    const surface = fixture();
    const before = surface.entries();
    const controller = new AbortController();
    controller.abort();
    const events: CompactionEvent[] = [];
    const listener = createCompactionListener({
      budget: { totalContextLimit: 1000, compactionThreshold: 20 },
      surface,
      offloader: createOffloader(createMemoryWorkspaceStore()),
      countTokens: () => 30,
      buildRecap,
      signal: controller.signal,
      emit: (event) => { events.push(event); },
      persist: () => { throw new Error("persist must not run"); },
    });
    await listener({ type: "agent_end", messages: [] });
    expect(surface.entries()).toEqual(before);
    expect(events.some((e) => e.type === "compaction_interrupted")).toBe(true);
  });

  test("safeCutIndex 在 offloader 中导出且不拆工具对", () => {
    const entries: SurfaceEntry[] = [
      { kind: "message", message: { role: "system", content: "s" } },
      { kind: "message", message: { role: "assistant", content: "a", toolCalls: [{ id: "c1", name: "edit", arguments: "{}" }] } },
      { kind: "message", message: { role: "toolResult", content: "r", toolCallId: "c1", toolName: "edit" } },
      { kind: "message", message: { role: "user", content: "u" } },
    ];
    expect(safeCutIndex(entries, 2)).toBe(3);
  });
});
