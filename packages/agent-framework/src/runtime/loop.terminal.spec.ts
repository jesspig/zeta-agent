import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent, type AgentMessage } from "./agent";
import { createInbox } from "./inbox";
import {
  runLoop,
  type AssistantResult,
  type LastTurn,
  type LoopRuntime,
  type SourcePollPhase,
  type ToolResult,
} from "./loop";

const assistant = (content: string): AssistantResult => ({
  message: { role: "assistant", content },
  toolCalls: [],
  stopReason: "stop",
});

function msg(content: string): AgentMessage {
  return { role: "user", content };
}

function harness() {
  const stream = createEventStream();
  const events: AgentEvent[] = [];
  stream.subscribe((event) => { events.push(event); });
  return {
    stream,
    events,
    inbox: createInbox(),
    emit: (event: AgentEvent) => stream.emit(event),
    getState: () => stream.getState(),
  };
}

function userContents(request: unknown): string[] {
  const messages = (request as { messages?: readonly AgentMessage[] }).messages ?? [];
  return messages.filter((item) => item.role === "user").map((item) => String(item.content));
}

describe("T-06 loop 三态终局与 inbox 边界", () => {
  test("decision end：预置 followUp/nextTurn/nextStep 原样保留且只请求一次 provider", async () => {
    const h = harness();
    h.inbox.followUp(msg("preset-follow"));
    h.inbox.inject(msg("preset-step"));
    let calls = 0;

    await runLoop({
      ...h,
      inbox: h.inbox,
      decision: () => ({ kind: "exit", reason: "decision-end" }),
      streamAssistant: async () => {
        calls += 1;
        h.inbox.steer(msg("late-steer"));
        return assistant(`r${calls}`);
      },
    });

    expect(calls).toBe(1);
    expect(h.inbox.size("followUp")).toBe(1);
    expect(h.inbox.size("nextTurn")).toBe(1);
    expect(h.inbox.size("nextStep")).toBe(1);
    expect(h.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(h.events.at(-1)?.type).toBe("agent_end");
  });

  test("all terminate：整批 terminate 与 decision end 同等硬终止，队列不清空", async () => {
    const h = harness();
    h.inbox.followUp(msg("preset-follow"));
    h.inbox.inject(msg("preset-step"));
    let calls = 0;

    await runLoop({
      ...h,
      inbox: h.inbox,
      streamAssistant: async () => {
        calls += 1;
        return {
          ...assistant("call"),
          toolCalls: [{ id: "c1", name: "stop", args: {} }],
        };
      },
      executeToolCalls: async (): Promise<readonly ToolResult[]> => [
        { callId: "c1", message: { role: "toolResult", content: "real" }, terminate: true },
      ],
    });

    expect(calls).toBe(1);
    expect(h.inbox.size("followUp")).toBe(1);
    expect(h.inbox.size("nextStep")).toBe(1);
    expect(h.events.at(-1)?.type).toBe("agent_end");
    expect(JSON.stringify(h.stream.getState().messages)).toContain("real");
  });

  test("natural end：外层消费 followUp 且保留 lastTurn 重跑 prepareNextTurn", async () => {
    const h = harness();
    h.inbox.followUp(msg("preset-follow"));
    let calls = 0;
    const prepared: Array<LastTurn | undefined> = [];

    await runLoop({
      ...h,
      inbox: h.inbox,
      prepareNextTurn: (turn) => { prepared.push(turn); },
      streamAssistant: async () => {
        calls += 1;
        return assistant(`r${calls}`);
      },
    });

    expect(calls).toBe(2);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toEqual({ message: { role: "assistant", content: "r1" }, toolResults: [] });
    expect(h.inbox.size("followUp")).toBe(0);
  });

  test("nextStep 在 prepareNextTurn 按 QueueMode=all/step claim，硬终局仍保留未取消息", async () => {
    for (const [mode, remaining] of [["all", 0], ["step", 1]] as const) {
      const h = harness();
      h.inbox.setMode(mode);
      h.inbox.inject(msg("step-1"));
      h.inbox.inject(msg("step-2"));
      const requests: unknown[] = [];
      let calls = 0;

      await runLoop({
        ...h,
        inbox: h.inbox,
        prepareRequest: (request) => { requests.push(request); return request; },
        finishTurn: () => ({ action: calls < 2 ? "continue" : "end" }),
        streamAssistant: async () => {
          calls += 1;
          return assistant(`r${calls}`);
        },
      });

      expect(userContents(requests[0])).toEqual([]);
      expect(userContents(requests[1])).toEqual(mode === "all" ? ["step-1", "step-2"] : ["step-1"]);
      expect(h.inbox.size("nextStep")).toBe(remaining);
    }
  });

  test("QueueMode=interrupt：steer 清空 nextStep 并插队 nextTurn 队首", async () => {
    const h = harness();
    h.inbox.setMode("interrupt");
    h.inbox.inject(msg("stale-step"));
    h.inbox.steer(msg("urgent"));
    const requests: unknown[] = [];

    await runLoop({
      ...h,
      inbox: h.inbox,
      prepareRequest: (request) => { requests.push(request); return request; },
      decision: () => ({ kind: "exit", reason: "done" }),
      streamAssistant: async () => assistant("r"),
    });

    expect(h.inbox.size("nextStep")).toBe(0);
    expect(userContents(requests[0])).toEqual(["urgent"]);
  });

  test("source 在 prepareNextTurn 与 finishTurn 之后重轮询，注入的消息进入下一轮", async () => {
    const h = harness();
    const phases: SourcePollPhase[] = [];
    const requests: unknown[] = [];
    let calls = 0;

    await runLoop({
      ...h,
      pollSources: (phase, signal) => {
        phases.push(phase);
        if (phase === "finishTurn") h.inbox.steer(msg("from-source"));
      },
      prepareRequest: (request) => { requests.push(request); return request; },
      finishTurn: () => ({ action: calls < 2 ? "continue" : "end" }),
      streamAssistant: async () => {
        calls += 1;
        return assistant(`r${calls}`);
      },
    });

    expect(calls).toBe(2);
    expect(phases).toEqual(["finishTurn", "prepareNextTurn"]);
    expect(userContents(requests[1])).toEqual(["from-source"]);
  });

  test("prepareNextTurn 返回值作为 NextTurnUpdate 应用（context/messages/model/thinkingLevel）", async () => {
    const h = harness();
    const requests: Array<Record<string, unknown>> = [];
    let calls = 0;

    await runLoop({
      ...h,
      prepareNextTurn: () => ({
        context: { topic: "next" },
        messages: [msg("from-update")],
        model: "model-2",
        thinkingLevel: "high",
      }),
      prepareRequest: (request) => {
        requests.push(request as Record<string, unknown>);
        return request;
      },
      finishTurn: () => ({ action: calls < 2 ? "continue" : "end" }),
      streamAssistant: async () => {
        calls += 1;
        return assistant(`r${calls}`);
      },
    });

    expect(calls).toBe(2);
    expect(requests[0]).not.toHaveProperty("context");
    expect(requests[1]).toMatchObject({ context: { topic: "next" }, model: "model-2", thinkingLevel: "high" });
    expect(userContents(requests[1])).toEqual(["from-update"]);
  });
});
