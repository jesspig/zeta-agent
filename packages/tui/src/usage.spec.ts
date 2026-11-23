import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@zeta-agent/agent";
import {
  createUsageTracker,
  extractTokenUsage,
  usageMetrics,
} from "./usage";

function messageEndWithUsage(content: unknown): AgentEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: "", usage: content } as never,
  };
}

describe("A7 真实遥测：agent usage → footer 指标", () => {
  test("extractTokenUsage 兼容 snake_case / camelCase 并忽略无用量的消息", () => {
    expect(
      extractTokenUsage({
        prompt_tokens: 1200,
        completion_tokens: 340,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    });
    expect(extractTokenUsage({ role: "user", content: "hi" })).toBe(null);
  });

  test("message_end 的真实 usage 累计为 token 指标与上下文占用", () => {
    const tracker = createUsageTracker({
      pricing: { inputPerMillion: 2, outputPerMillion: 5 },
    });
    tracker.consume(messageEndWithUsage({ input_tokens: 1000, output_tokens: 200 }));
    tracker.consume(messageEndWithUsage({ input_tokens: 500, output_tokens: 100 }));
    tracker.consume({ type: "turn_start" });

    const snapshot = tracker.snapshot();
    expect(snapshot.usedTokens).toBe(1500);
    expect(snapshot.metrics.inputTokens).toBe(1500);
    expect(snapshot.metrics.outputTokens).toBe(300);
    expect(snapshot.metrics.costUsd).toBeCloseTo((1500 * 2 + 300 * 5) / 1_000_000);
  });

  test("初始用量可恢复会话快照，成本按定价计算", () => {
    const metrics = usageMetrics(
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputPerMillion: 3, outputPerMillion: 9 },
    );
    expect(metrics.cacheHitPercent).toBe(0);
    expect(metrics.costUsd).toBeCloseTo(0.003);

    const tracker = createUsageTracker({ initialUsage: { inputTokens: 1000 } });
    expect(tracker.snapshot().usedTokens).toBe(1000);
  });
});
