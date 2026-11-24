import { describe, expect, test } from "bun:test";
import { createInbox } from "./inbox";
import { runLoop, type AssistantResult, type LoopRuntime, type ToolResult } from "./loop";
import { createEventStream, type AgentEvent } from "./agent";
import {
  createToolPipeline,
  createToolRegistry,
  type ToolDescriptor,
} from "../tools/pipeline";

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "tool",
    inputSchema: [],
    outputSchema: undefined,
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("T-08 loop real-time completion events", () => {
  test("end events fire in completion order with name/args/duration; transcript stays in source order", async () => {
    const registry = createToolRegistry();
    registry.registerTool(
      descriptor({
        name: "slow",
        inputSchema: ["tag"],
        execute: async () => {
          await delay(25);
          return { ok: "slow" };
        },
      })
    );
    registry.registerTool(
      descriptor({
        name: "fast",
        inputSchema: ["tag"],
        execute: async () => {
          await delay(2);
          return { ok: "fast" };
        },
      })
    );
    const stream = createEventStream();
    const events: AgentEvent[] = [];
    stream.subscribe((event) => void events.push(event));
    const inbox = createInbox();
    inbox.steer({ role: "user", content: "go" });
    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      toolPipeline: createToolPipeline({ registry }),
      streamAssistant: async (): Promise<AssistantResult> => ({
        message: { role: "assistant", content: "r" },
        toolCalls: [
          { id: "c1", name: "slow", args: { tag: "first" } },
          { id: "c2", name: "fast", args: { tag: "second" } },
        ],
        stopReason: "stop",
      }),
      finishTurn: () => ({ action: "end" }),
    };
    await runLoop(runtime);

    const ends = events.filter((event) => event.type === "tool_execution_end");
    expect(ends.map((event) => (event as { toolCallId: string }).toolCallId)).toEqual(["c2", "c1"]);
    const fastEnd = ends[0] as Extract<AgentEvent, { type: "tool_execution_end" }>;
    expect(fastEnd.toolName).toBe("fast");
    expect(fastEnd.args).toEqual({ tag: "second" });
    expect(typeof fastEnd.durationMs).toBe("number");
    const transcript = stream
      .getState()
      .messages.filter((message) => message.role === "toolResult")
      .map((message) => JSON.stringify(message.content));
    expect(transcript[0]).toContain("slow");
    expect(transcript[1]).toContain("fast");
  });

  test("all-terminate keeps real results and prevents any further provider call", async () => {
    const registry = createToolRegistry();
    const terminating = (name: string): ToolDescriptor =>
      descriptor({
        name,
        execute: (_input, exec) => {
          exec.terminate();
          return { ok: `real-${name}` };
        },
      });
    registry.registerTool(terminating("a"));
    registry.registerTool(terminating("b"));
    let providerCalls = 0;
    const stream = createEventStream();
    const inbox = createInbox();
    inbox.steer({ role: "user", content: "go" });
    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      toolPipeline: createToolPipeline({ registry }),
      streamAssistant: async (): Promise<AssistantResult> => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            message: { role: "assistant", content: "call" },
            toolCalls: [
              { id: "c1", name: "a", args: {} },
              { id: "c2", name: "b", args: {} },
            ],
            stopReason: "stop",
          };
        }
        return {
          message: { role: "assistant", content: "should-not-run" },
          toolCalls: [],
          stopReason: "stop",
        };
      },
      finishTurn: () => undefined,
    };
    await runLoop(runtime);
    expect(providerCalls).toBe(1);
    const results = stream.getState().messages.filter((message) => message.role === "toolResult");
    expect(JSON.stringify(results)).toContain("real-a");
    expect(JSON.stringify(results)).toContain("real-b");
    expect(JSON.stringify(results)).not.toContain("BATCH_TERMINATED");
  });

  test("turn budget ends the loop before the next provider call", async () => {
    let providerCalls = 0;
    const stream = createEventStream();
    const inbox = createInbox();
    inbox.steer({ role: "user", content: "go" });
    const runtime: LoopRuntime = {
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      turnBudget: 1,
      streamAssistant: async (): Promise<AssistantResult> => {
        providerCalls += 1;
        return {
          message: { role: "assistant", content: "x" },
          toolCalls: [{ id: `c${providerCalls}`, name: "noop", args: {} }],
          stopReason: "stop",
        };
      },
      executeToolCalls: async (calls): Promise<readonly ToolResult[]> =>
        calls.map((call) => ({
          callId: call.id,
          message: { role: "toolResult", content: "ok", toolCallId: call.id },
        })),
      finishTurn: () => undefined,
    };
    await runLoop(runtime);
    expect(providerCalls).toBe(1);
  });
});
