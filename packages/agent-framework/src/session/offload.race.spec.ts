import { describe, expect, test } from "bun:test";
import { createEventStream } from "../runtime/agent";
import { createSessionSurface, createRecap, type SemanticRecap } from "./surface";
import { createCompactionListener, createOffloader, createMemoryWorkspaceStore } from "./offload";

const RECAP: SemanticRecap = createRecap({
  objective: "x",
  establishedFacts: [],
  appliedChanges: [],
  verification: [],
  deadEnds: [],
  remainingPlan: [],
});

/** CR-19：外置等待期间 surface 被改动时，压缩不能按过期区间替换。 */
describe("T-18 压缩条件提交", () => {
  test("等待 offload 期间 surface 变化时放弃旧区间替换", async () => {
    const surface = createSessionSurface();
    surface.append({ role: "user", content: "A" });
    surface.append({ role: "user", content: "B" });
    surface.append({ role: "user", content: "C" });
    const originalFirst = surface.entries()[0];

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const offloader = {
      offload: async () => { await gate; return "workspace:///bump"; },
      retrieve: async () => undefined,
    };
    const stream = createEventStream();
    const listener = createCompactionListener({
      budget: { totalContextLimit: 1000, compactionThreshold: 20 },
      surface,
      offloader,
      countTokens: () => 50,
      buildRecap: () => RECAP,
      persist: () => {},
    });
    stream.subscribe(listener);
    const pending = stream.emit({ type: "agent_end", messages: [] });

    // 外置等待期间，另一个压缩把首条替换成 recap
    surface.replace({
      start: 0,
      end: 1,
      recap: RECAP,
      uris: ["workspace:///other"],
      threshold: 20,
      preTokenCount: 50,
    });
    release();
    await pending;

    const entries = surface.entries();
    // 本次迟到压缩不得按旧区间写入；应保留期间发生的 other 压缩结果
    const uris = entries.filter((e) => e.kind === "recap").flatMap((e) => (e as { uris: readonly string[] }).uris);
    expect(uris).toContain("workspace:///other");
    expect(uris).not.toContain("workspace:///bump");
  });
});
