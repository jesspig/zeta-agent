import { describe, expect, test } from "bun:test";
import { createAgent } from "./core";
import type { AgentEvent } from "./agent";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1000 && !predicate(); index += 1) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

describe("T-06 公共 core run 所有权", () => {
  test("异步 prepareRequest 在 provider 前完成", async () => {
    const gate = deferred();
    const order: string[] = [];
    const agent = createAgent({
      streamFn: async function* () {
        order.push("stream");
        yield "ok";
      },
    });
    agent.api.addPrepareRequest(async (request) => {
      order.push("prepare:start");
      await gate.promise;
      order.push("prepare:end");
      return request;
    });
    const running = agent.prompt("hi");
    await waitUntil(() => order.includes("prepare:start"));
    expect(order).toEqual(["prepare:start"]);
    gate.resolve();
    await running;
    expect(order).toEqual(["prepare:start", "prepare:end", "stream"]);
  });

  test("并发 prompt 与运行中 reset 被拒绝且不污染当前 run", async () => {
    const gate = deferred();
    const agent = createAgent({
      streamFn: async function* () {
        await gate.promise;
        yield "first";
      },
    });
    const first = agent.prompt("first");
    await waitUntil(() => agent.state.isStreaming);
    await expect(agent.prompt("second")).rejects.toThrow(/ACTIVE_RUN/);
    expect(() => agent.reset()).toThrow(/ACTIVE_RUN/);
    expect(agent.state.messages.some((message) => String(message.content).includes("second"))).toBe(false);
    gate.resolve();
    await first;
    expect(agent.state.messages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "first" },
    ]);
    agent.reset();
    expect(agent.state.messages).toEqual([]);
  });

  test("waitForIdle 等待 run 主体、工具清理与 agent_end listener", async () => {
    const toolGate = deferred();
    const listenerGate = deferred();
    let streams = 0;
    let toolStarted = false;
    const agent = createAgent({
      tools: [{ name: "slow", execute: async () => { toolStarted = true; await toolGate.promise; return "done"; } }],
      streamFn: async function* () {
        streams += 1;
        if (streams === 1) yield { type: "tool_call", id: "c1", name: "slow", arguments: "{}" };
        else yield "done";
      },
    });
    let toolFinished = false;
    let listenerEntered = false;
    agent.api.addAfterToolCall(async () => { toolFinished = true; });
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        listenerEntered = true;
        await listenerGate.promise;
      }
    });
    const running = agent.prompt("go");
    await waitUntil(() => toolStarted);
    let idle = false;
    const waiting = agent.waitForIdle().then(() => { idle = true; });
    await Bun.sleep(5);
    expect(idle).toBe(false);
    toolGate.resolve();
    await waitUntil(() => listenerEntered);
    expect(idle).toBe(false);
    listenerGate.resolve();
    await waiting;
    await running;
    expect(idle).toBe(true);
  });

  test("signal 贯穿 prepare hook、listener 与 tool execute", async () => {
    const signals: AbortSignal[] = [];
    let toolSignal: AbortSignal | undefined;
    let streams = 0;
    const agent = createAgent({
      tools: [{ name: "capture", execute: (_input, signal) => { toolSignal = signal; return "ok"; } }],
      streamFn: async function* () {
        streams += 1;
        if (streams === 1) yield { type: "tool_call", id: "c1", name: "capture", arguments: "{}" };
        else yield "done";
      },
    });
    agent.api.addPrepareRequest(async (request, signal) => {
      signals.push(signal!);
      return request;
    });
    agent.subscribe((_event, signal) => { signals.push(signal!); });
    await agent.prompt("go");
    expect(signals.length).toBeGreaterThan(0);
    expect(new Set(signals).size).toBe(1);
    expect(toolSignal).toBe(signals[0]);
  });

  test("agent_end.newMessages 不含历史且 provider 异常仍有完整终态", async () => {
    const ends: Array<Extract<AgentEvent, { type: "agent_end" }>> = [];
    const agent = createAgent({
      streamFn: async function* () {
        yield "before-error";
        throw new Error("PROVIDER_FAILURE");
      },
    });
    agent.subscribe((event) => { if (event.type === "agent_end") ends.push(event); });
    await agent.prompt("first");
    await agent.prompt("second");
    expect(ends).toHaveLength(2);
    expect(ends[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(ends[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(ends[1]?.messages.some((message) => String(message.content).includes("PROVIDER_FAILURE"))).toBe(true);
    expect(agent.state.messages.length).toBeGreaterThan(ends[1]!.messages.length);
  });

  test("默认 natural end：预置 follow-up 在同一次 run 的外层消费", async () => {
    const requests: string[] = [];
    let streams = 0;
    let injectFollowUp = (): void => {};
    const agent = createAgent({
      tools: [{ name: "noop", execute: () => "ok" }],
      streamFn: async function* (request) {
        streams += 1;
        const messages = (request as { messages: readonly { role: string; content: unknown }[] }).messages;
        requests.push(String(messages.filter((message) => message.role === "user").at(-1)?.content ?? ""));
        if (streams === 1) {
          injectFollowUp();
          yield { type: "tool_call", id: "c1", name: "noop", arguments: "{}" };
        } else yield "ok";
      },
    });
    injectFollowUp = () => agent.followUp({ role: "user", content: "follow" });
    await agent.prompt("first");

    expect(streams).toBe(3);
    expect(requests).toEqual(["first", "first", "follow"]);
    expect(agent.queueSize("followUp")).toBe(0);
  });

  test("显式 decision end 保留 follow-up，下一次 prompt 的自然终局才消费", async () => {
    const requests: string[] = [];
    let streams = 0;
    let decisions = 0;
    const agent = createAgent({
      // 只在第一次 prompt 硬终止；之后恢复默认 natural，验证保留队列不永久滞留。
      loopHooks: { finishTurn: () => (++decisions === 1 ? { action: "end" } : undefined) },
      streamFn: async function* (request) {
        streams += 1;
        const messages = (request as { messages: readonly { role: string; content: unknown }[] }).messages;
        requests.push(String(messages.filter((message) => message.role === "user").at(-1)?.content ?? ""));
        yield "ok";
      },
    });
    agent.followUp({ role: "user", content: "follow" });

    await agent.prompt("first");
    expect(streams).toBe(1);
    expect(requests).toEqual(["first"]);
    expect(agent.queueSize("followUp")).toBe(1);

    await agent.prompt("second");
    expect(streams).toBe(3);
    expect(requests).toEqual(["first", "second", "follow"]);
    expect(agent.queueSize("followUp")).toBe(0);
  });

  test("公开 inject/QueueMode 接入 runLoop：step 每次 claim 一条 nextStep", async () => {
    const requests: string[] = [];
    let streams = 0;
    const agent = createAgent({
      tools: [{ name: "noop", execute: () => "ok" }],
      streamFn: async function* (request) {
        streams += 1;
        const messages = (request as { messages: readonly { role: string; content: unknown }[] }).messages;
        requests.push(String(messages.filter((message) => message.role === "user").at(-1)?.content ?? ""));
        if (streams === 1) yield { type: "tool_call", id: "c1", name: "noop", arguments: "{}" };
        else yield "ok";
      },
    });
    agent.setQueueMode("step");
    agent.inject({ role: "user", content: "step-1" });
    agent.inject({ role: "user", content: "step-2" });
    expect(agent.getQueueMode()).toBe("step");
    expect(agent.queueSize("nextStep")).toBe(2);

    await agent.prompt("go");

    expect(requests).toEqual(["go", "step-1", "step-2"]);
    expect(agent.queueSize("nextStep")).toBe(0);
  });

  test("公开 setQueueMode(interrupt)：steer 清空 nextStep 并插队 nextTurn 队首", async () => {
    const requests: string[][] = [];
    const agent = createAgent({
      streamFn: async function* (request) {
        const messages = (request as { messages: readonly { role: string; content: unknown }[] }).messages;
        requests.push(messages.filter((message) => message.role === "user").map((message) => String(message.content)));
        yield "ok";
      },
    });
    agent.inject({ role: "user", content: "stale" });
    agent.setQueueMode("interrupt");
    agent.steer({ role: "user", content: "urgent" });

    await agent.prompt("go");

    expect(agent.queueSize("nextStep")).toBe(0);
    // interrupt 把每次 steer 的 message unshift 到队首：最后入队的 "go" 在最前。
    expect(requests[0]).toEqual(["go", "urgent"]);
  });
});
