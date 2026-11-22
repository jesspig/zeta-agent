import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@zeta-agent/agent";
import { applyTimelineEvent, createTimelineState, type TimelineAssistantEntry, type TimelineToolEntry } from "./timeline";

const user = { role: "user" as const, content: "hello" };
const assistant = { role: "assistant" as const, content: "hi" };

function run(events: readonly AgentEvent[]) {
  let state = createTimelineState();
  for (const event of events) state = applyTimelineEvent(state, event);
  return state;
}

describe("对话时间线归约", () => {
  test("用户 → 助手 → 工具 → 助手 按发生顺序内联排列", () => {
    const state = run([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: user },
      { type: "message_end", message: user },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "先读文件" } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "content", isError: false, durationMs: 12 },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "读完了" } },
      { type: "agent_end", messages: [user, assistant] },
    ]);

    expect(state.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = state.entries[2] as TimelineToolEntry;
    expect(tool.name).toBe("read");
    expect(tool.status).toBe("done");
    expect(tool.durationMs).toBe(12);
    expect(tool.result).toBe("content");
    expect(state.entries[0]!.kind === "user" ? state.entries[0]!.text : "").toBe("hello");
  });

  test("message_update 就地更新同一个助手条目并保留思考内容", () => {
    let state = createTimelineState();
    state = applyTimelineEvent(state, { type: "message_start", message: { role: "assistant", content: "" } });
    state = applyTimelineEvent(state, {
      type: "message_update",
      message: { role: "assistant", content: "你", thinking: "想一想" },
      assistantMessageEvent: { type: "text_delta", delta: "你" },
    });
    state = applyTimelineEvent(state, {
      type: "message_update",
      message: { role: "assistant", content: "你好", thinking: "想一想" },
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    });
    state = applyTimelineEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: "你好！", thinking: "想一想" },
    });

    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0] as TimelineAssistantEntry;
    expect(entry.text).toBe("你好！");
    expect(entry.thinking).toBe("想一想");
    expect(entry.streaming).toBe(false);
  });

  test("工具失败标记为 error，缺失的工具事件不重复追加", () => {
    const state = run([
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } },
      { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: "run" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "", result: "boom", isError: true },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "", result: "boom", isError: true },
    ]);
    expect(state.entries).toHaveLength(1);
    const tool = state.entries[0] as TimelineToolEntry;
    expect(tool.status).toBe("error");
    expect(tool.name).toBe("bash");
    expect(tool.partialResult).toBe("run");
  });

  test("agent_end 会清理流式标记；空时间线可从历史消息恢复", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "abc" }, assistantMessageEvent: { type: "text_delta" } },
      { type: "agent_end", messages: [] },
    ]);
    expect(state.status).toBe("idle");
    expect((state.entries[0] as TimelineAssistantEntry).streaming).toBe(false);

    const restored = createTimelineState([
      { role: "user", content: "q" },
      { role: "assistant", content: "a", thinking: "t" },
      { role: "toolResult", content: "tool output" },
    ]);
    expect(restored.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "notice"]);

    const blocks = createTimelineState([
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "思考块" },
          { type: "text", text: "正文" },
        ],
      },
    ]);
    const entry = blocks.entries[0] as TimelineAssistantEntry;
    expect(entry.thinking).toBe("思考块");
    expect(entry.text).toBe("正文");
  });
});
