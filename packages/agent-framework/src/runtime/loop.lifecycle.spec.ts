import { describe, expect, test } from "bun:test";
import { createEventStream, type AgentEvent } from "./agent";
import { createInbox } from "./inbox";
import { runLoop, type LoopRuntime } from "./loop";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(options: {
  inbox?: ReturnType<typeof createInbox>;
  streamAssistant?: LoopRuntime["streamAssistant"];
  prepareNextTurn?: LoopRuntime["prepareNextTurn"];
  prepareRequest?: LoopRuntime["prepareRequest"];
  finishTurn?: LoopRuntime["finishTurn"];
  executeToolCalls?: LoopRuntime["executeToolCalls"];
  pollFollowUp?: LoopRuntime["pollFollowUp"];
} = {}): { runtime: LoopRuntime; stream: ReturnType<typeof createEventStream>; events: AgentEvent[] } {
  const stream = createEventStream();
  const events: AgentEvent[] = [];
  stream.subscribe((event) => { events.push(event); });
  return {
    stream,
    events,
    runtime: {
      inbox: options.inbox ?? createInbox(),
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      prepareNextTurn: options.prepareNextTurn,
      prepareRequest: options.prepareRequest,
      finishTurn: options.finishTurn,
      executeToolCalls: options.executeToolCalls,
      pollFollowUp: options.pollFollowUp,
      streamAssistant: options.streamAssistant ?? (async () => ({
        message: { role: "assistant", content: "ok" },
        toolCalls: [],
        stopReason: "stop",
      })),
    },
  };
}

describe("T-06 loop await、队列与终态", () => {
  test("prepareRequest Promise 未完成前不请求 provider", async () => {
    const gate = deferred();
    let prepared = false;
    let streams = 0;
    const { runtime: loop } = runtime({
      prepareRequest: async (request) => {
        await gate.promise;
        prepared = true;
        return request;
      },
      streamAssistant: async () => {
        streams += 1;
        return { message: { role: "assistant", content: "ok" }, toolCalls: [], stopReason: "stop" };
      },
    });
    const running = runLoop(loop);
    await Promise.resolve();
    expect(prepared).toBe(false);
    expect(streams).toBe(0);
    gate.resolve();
    await running;
    expect(streams).toBe(1);
  });

  test("prepareNextTurn 与 finishTurn 均被 await", async () => {
    const nextGate = deferred();
    const finishGate = deferred();
    const order: string[] = [];
    let turn = 0;
    const { runtime: loop, events } = runtime({
      prepareNextTurn: async () => {
        order.push("prepare:start");
        await nextGate.promise;
        order.push("prepare:end");
      },
      streamAssistant: async () => {
        turn += 1;
        order.push(`stream:${turn}`);
        return {
          message: { role: "assistant", content: String(turn) },
          toolCalls: turn === 1 ? [{ id: "c1", name: "tool", args: {} }] : [],
          stopReason: turn > 2 ? "error" : "stop",
        };
      },
      executeToolCalls: undefined,
      finishTurn: async (turn) => {
        order.push(`finish:${String(turn.message.content)}:start`);
        if (turn.message.content === "2") await finishGate.promise;
        order.push(`finish:${String(turn.message.content)}:end`);
        return { action: turn.message.content === "1" ? "continue" : "end" };
      },
    });
    const running = runLoop(loop);
    await Bun.sleep(0);
    expect(order).toEqual(["stream:1", "finish:1:start", "finish:1:end", "prepare:start"]);
    nextGate.resolve();
    await Bun.sleep(0);
    expect(order).toContain("prepare:end");
    expect(order.indexOf("prepare:end")).toBeLessThan(order.indexOf("stream:2"));
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
    finishGate.resolve();
    await running;
    expect(order.at(-1)).toBe("finish:2:end");
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  test("natural end：steering 优先续跑，follow-up 在外层消费且保留 lastTurn", async () => {
    const inbox = createInbox();
    const seen: string[] = [];
    const allSeen: string[][] = [];
    let requests = 0;
    let prepared = 0;
    const { runtime: loop } = runtime({
      inbox,
      prepareNextTurn: () => { prepared += 1; },
      streamAssistant: async (request) => {
        requests += 1;
        const messages = (request as { messages: readonly { role: string; content: unknown }[] }).messages;
        const users = messages.filter((message) => message.role === "user").map((message) => String(message.content));
        allSeen.push(users);
        seen.push(users.at(-1) ?? "");
        if (requests === 1) {
          inbox.steer({ role: "user", content: "steer" });
          inbox.followUp({ role: "user", content: "follow" });
        }
        return { message: { role: "assistant", content: "ok" }, toolCalls: [], stopReason: "stop" };
      },
      // 不提供 finishTurn：无显式决策，内层耗尽后才是 natural end。
    });
    await runLoop(loop);
    expect(seen).toEqual(["", "steer", "follow"]);
    expect(allSeen[1]).toEqual(["steer"]);
    expect(allSeen[2]).toEqual(["steer", "follow"]); // transcript 保留，lastTurn 不清空
    // 两次 prepareNextTurn：steer 续跑一次，follow-up 从外层回来再一次（lastTurn 未被清空）。
    expect(prepared).toBe(2);
    expect(inbox.size("nextTurn")).toBe(0);
    expect(inbox.size("followUp")).toBe(0);
  });

  test("agent_end.messages 只含本次新增消息且不截断历史状态", async () => {
    const { runtime: loop, stream, events } = runtime();
    await stream.emit({ type: "message_end", message: { role: "user", content: "old" } });
    await runLoop(loop);
    const end = events.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type === "agent_end") expect(end.messages).toEqual([{ role: "assistant", content: "ok" }]);
    expect(stream.getState().messages).toEqual([
      { role: "user", content: "old" },
      { role: "assistant", content: "ok" },
    ]);
  });

  test("length 截断工具不执行", async () => {
    let executions = 0;
    const { runtime: loop } = runtime({
      streamAssistant: async () => ({
        message: { role: "assistant", content: "partial" },
        toolCalls: [{ id: "c1", name: "write", args: {} }],
        stopReason: "length",
      }),
      finishTurn: () => ({ action: "end" }),
    });
    loop.executeToolCalls = async () => {
      executions += 1;
      return [];
    };
    await runLoop(loop);
    expect(executions).toBe(0);
  });
});
