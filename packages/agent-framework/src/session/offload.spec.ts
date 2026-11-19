import { describe, expect, test } from "bun:test";
import { createEventStream } from "../runtime/agent";
import { createRecap, createSessionSurface, type CompactionLineage, type SemanticRecap } from "./surface";
import {
  checkBudget,
  createBudgetTracker,
  createCompactionListener,
  createMemoryWorkspaceStore,
  createOffloader,
} from "./offload";

const recap: SemanticRecap = createRecap({
  objective: "compact context",
  establishedFacts: [{ text: "dual threshold", kind: "observation" }],
  appliedChanges: [],
  verification: [],
  deadEnds: [],
  remainingPlan: ["resume work"],
});

describe("T-23 offloader dual threshold budget and barrier", () => {
  test("offloader externalizes a block to a workspace URI and retrieves it", async () => {
    const store = createMemoryWorkspaceStore();
    const offloader = createOffloader(store);
    const block = { kind: "toolResult", payload: [1, 2, 3] };

    const uri = await offloader.offload(block, "tool-result");
    expect(uri.startsWith("workspace:///")).toBe(true);
    expect(await offloader.retrieve(uri)).toEqual(block);
    expect(await offloader.retrieve("workspace:///missing")).toBeUndefined();

    let message = "";
    try {
      await offloader.retrieve("https://example.com/data");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("workspace");
  });

  test("budget uses dual thresholds and tracks peak live tokens", () => {
    const budget = { totalContextLimit: 100, compactionThreshold: 70 };
    expect(checkBudget(budget, 50)).toBe("ok");
    expect(checkBudget(budget, 70)).toBe("compact");
    expect(checkBudget(budget, 101)).toBe("exceeded");

    expect(() => checkBudget({ totalContextLimit: 50, compactionThreshold: 50 }, 10)).toThrow();

    const tracker = createBudgetTracker({ ...budget, peakLiveContextTokens: 90 });
    expect(tracker.observe(60)).toBe("ok");
    expect(tracker.observe(80)).toBe("compact");
    expect(tracker.peak).toBe(80);
    expect(tracker.decision).toBe("compact");
  });

  test("agent_end listener compacts above threshold and persists before emit resolves", async () => {
    const surface = createSessionSurfaceFixture();
    const offloader = createOffloader(createMemoryWorkspaceStore());
    const expectedBlock = surface.entries().slice(0, 2);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let persisted = false;
    let seen: readonly CompactionLineage[] = [];

    const listener = createCompactionListener({
      budget: { totalContextLimit: 1000, compactionThreshold: 20, peakLiveContextTokens: 500 },
      surface,
      offloader,
      countTokens: () => 30,
      buildRecap: () => recap,
      persist: async (lineages) => {
        await gate;
        persisted = true;
        seen = lineages;
      },
    });

    const stream = createEventStream();
    stream.subscribe(listener);
    const pending = stream.emit({ type: "agent_end", messages: [] });

    expect(persisted).toBe(false);
    release();
    await pending;

    expect(persisted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.preTokenCount).toBe(30);
    expect(seen[0]?.threshold).toBe(20);
    expect(surface.entries()[0]?.kind).toBe("recap");
    const uri = seen[0]?.uris[0];
    if (uri === undefined) throw new Error("missing uri");
    expect(uri.startsWith("workspace:///")).toBe(true);
    expect(await offloader.retrieve(uri)).toEqual(expectedBlock);
  });

  test("hard limit above totalContextLimit rejects before persistence", async () => {
    const surface = createSessionSurfaceFixture();
    const listener = createCompactionListener({
      budget: { totalContextLimit: 50, compactionThreshold: 20 },
      surface,
      offloader: createOffloader(createMemoryWorkspaceStore()),
      countTokens: () => 51,
      buildRecap: () => recap,
      persist: () => {
        throw new Error("persist must not run");
      },
    });

    let message = "";
    try {
      await listener({ type: "agent_end", messages: [] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("totalContextLimit");
  });
});

function createSessionSurfaceFixture() {
  const surface = createSessionSurface();
  surface.append({ role: "system", content: "objective" });
  surface.append({ role: "user", content: "question" });
  surface.append({ role: "assistant", content: "answer" });
  return surface;
}
