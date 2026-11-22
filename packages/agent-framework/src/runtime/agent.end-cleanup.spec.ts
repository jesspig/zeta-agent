import { describe, expect, test } from "bun:test";
import { createEventStream, reduceState, type AgentEvent } from "./agent";

/** CR-10：agent_end 必须清理该运行的 pending 工具状态，即使监听器失败。 */
describe("T-10 终止事件清理 pending", () => {
  test("reduceState 在 agent_end 清空 pendingToolCalls", () => {
    let state = reduceState(
      { systemPrompt: "", isStreaming: false, pendingToolCalls: new Set(), messages: [] },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "t", args: {} },
    );
    expect(state.pendingToolCalls.size).toBe(1);
    state = reduceState(state, { type: "agent_end", messages: [] });
    expect(state.pendingToolCalls.size).toBe(0);
  });

  test("监听器在 tool_execution_start 失败后 agent_end 仍清空 pending", async () => {
    const stream = createEventStream();
    const off = stream.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") throw new Error("listener boom");
    });
    try {
      await stream.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "t", args: {} });
    } catch {
      // 监听器失败会被 emit 抛出；状态仍应已写入 pending。
    }
    expect(stream.getState().pendingToolCalls.size).toBe(1);
    // 运行收尾发出 agent_end；即便该 emit 的监听器再次抛错，状态也应先被清理
    await stream.emit({ type: "agent_end", messages: [] });
    expect(stream.getState().pendingToolCalls.size).toBe(0);
    off();
  });
});
