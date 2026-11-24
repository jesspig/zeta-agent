import { describe, expect, test } from "bun:test";
import type { CompactionEvent } from "@zeta-agent/agent-framework";
import { createAuditSink } from "@zeta-agent/security";
import { createAgent, type AgentStreamFn, type AgentStreamChunk } from "./facade";
import type { SessionStore } from "./session/store";

const streamFn: AgentStreamFn = async function* (): AsyncIterable<AgentStreamChunk> {
  yield { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 4 } };
};

describe("T-12 facade 压缩装配", () => {
  test("注入 compaction 后经 SessionStore 落 recap 血缘并发出 usage 事件", async () => {
    const recaps: Array<{ recap: unknown; uris: readonly string[]; threshold?: number; preTokenCount?: number }> = [];
    const sessionStore = {
      append: async () => ({}),
      appendRecap: async (recap: unknown, uris: readonly string[], options?: { threshold?: number; preTokenCount?: number }) => {
        recaps.push({ recap, uris, threshold: options?.threshold, preTokenCount: options?.preTokenCount });
        return {};
      },
    } as unknown as SessionStore;
    const events: CompactionEvent[] = [];
    const auditSink = createAuditSink();
    const agent = createAgent({
      streamFn,
      sessionStore,
      auditSink,
      compaction: {
        budget: { totalContextLimit: 10000, compactionThreshold: 1 },
        emit: (event) => { events.push(event); },
      },
    });

    await agent.prompt("compact me");

    expect(agent.compaction).toBeDefined();
    expect(recaps.length).toBeGreaterThan(0);
    expect(recaps[0]?.uris[0]?.startsWith("workspace:///")).toBe(true);
    expect(events.map((e) => e.type)).toContain("compaction_completed");
    const completed = events.find((e) => e.type === "compaction_completed");
    expect(completed?.type === "compaction_completed" && completed.usage.compactionCount).toBeGreaterThan(0);
    expect(auditSink.entries.some((e) => e.record.toolName === "compaction" && e.record.decision.includes("compaction"))).toBe(true);
  });
});
