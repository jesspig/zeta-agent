import { describe, expect, test } from "bun:test";
import { createTimelineState, applyTimelineEvent, type TimelineToolEntry } from "./timeline";

/** CR-31：相同 toolCallId 跨轮复用时应生成独立卡片，不能覆盖上一轮。 */
describe("T-31 工具卡显示身份", () => {
  test("重复的 toolCallId 产生两个独立条目", () => {
    let state = createTimelineState();
    const start = (turn: number) => ({
      type: "tool_execution_start" as const,
      toolCallId: "c1",
      toolName: "t",
      args: { turn },
    });
    state = applyTimelineEvent(state, start(1));
    state = applyTimelineEvent(state, { type: "tool_execution_end" as const, toolCallId: "c1", toolName: "t", result: "r1", isError: false });
    state = applyTimelineEvent(state, start(2));
    const tools = state.entries.filter((e): e is TimelineToolEntry => e.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.id).not.toBe(tools[1]?.id);
  });
});
