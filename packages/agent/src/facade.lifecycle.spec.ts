import { describe, expect, test } from "bun:test";
import { createAgent, type AgentEvent, type AgentStreamChunk } from "./facade";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1000 && !predicate(); index += 1) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

describe("T-06 公共 facade 生命周期", () => {
  test("异步 prepareRequest/prepareNextTurn/finishTurn 全部形成屏障", async () => {
    const gate = deferred();
    const order: string[] = [];
    let streams = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* () {
        streams += 1;
        order.push(`stream:${streams}`);
        if (streams === 1) yield { type: "tool_call", id: "c1", name: "noop", arguments: "{}" };
        else yield "ok";
      },
    });
    agent.api.registerTool({ name: "noop", execute: () => "ok" });
    agent.api.addPrepareRequest(async (request) => {
      order.push("prepareRequest:start");
      await gate.promise;
      order.push("prepareRequest:end");
      return request;
    });
    agent.api.addPrepareNextTurn(async () => {
      order.push("prepareNextTurn:start");
      await Promise.resolve();
      order.push("prepareNextTurn:end");
    });
    agent.api.addTurnBoundary(async () => {
      order.push("finishTurn:start");
      await Promise.resolve();
      order.push("finishTurn:end");
    });
    agent.subscribe((event) => { if (event.type === "agent_end") order.push("agent_end"); });
    const running = agent.prompt("go");
    await waitUntil(() => order.includes("prepareRequest:start"));
    expect(streams).toBe(0);
    gate.resolve();
    await running;
    expect(order.indexOf("prepareRequest:end")).toBeLessThan(order.indexOf("stream:1"));
    expect(order.indexOf("prepareNextTurn:end")).toBeLessThan(order.indexOf("stream:2"));
    expect(order.indexOf("finishTurn:end")).toBeLessThan(order.indexOf("agent_end"));
  });

  test("prompt/reset 互斥，idle 等待 agent_end listener", async () => {
    const runGate = deferred();
    const endGate = deferred();
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* () { await runGate.promise; yield "ok"; },
    });
    let ended = false;
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") { ended = true; await endGate.promise; }
    });
    const running = agent.prompt("first");
    try {
      await waitUntil(() => agent.state.isStreaming);
      await expect(agent.prompt("second")).rejects.toThrow(/ACTIVE_RUN/);
      expect(() => agent.reset()).toThrow(/ACTIVE_RUN/);
      runGate.resolve();
      await waitUntil(() => ended);
      let idle = false;
      const waiting = agent.waitForIdle().then(() => { idle = true; });
      await Bun.sleep(5);
      expect(idle).toBe(false);
      endGate.resolve();
      await waiting;
      await running;
      expect(agent.state.messages.filter((message) => message.role === "user")).toEqual([
        { role: "user", content: "first" },
      ]);
    } finally {
      runGate.resolve();
      endGate.resolve();
      await Promise.allSettled([running]);
    }
  });

  test("signal 贯穿 hook、listener、provider 与 tool", async () => {
    const signals: AbortSignal[] = [];
    let toolSignal: AbortSignal | undefined;
    let streams = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* (request) {
        streams += 1;
        signals.push(request.signal!);
        if (streams === 1) yield { type: "tool_call", id: "c1", name: "capture", arguments: "{}" };
        else yield "ok";
      },
    });
    agent.api.registerTool({ name: "capture", execute: (_input, signal) => { toolSignal = signal; return "ok"; } });
    agent.api.addBeforeToolCall(async (_event, signal) => { signals.push(signal!); });
    agent.subscribe((_event, signal) => { signals.push(signal!); });
    await agent.prompt("go");
    expect(signals.length).toBeGreaterThan(0);
    expect(new Set(signals).size).toBe(1);
    expect(toolSignal).toBe(signals[0]);
  });

  test("agent_end.messages 仅本次新增，done/error 元数据进入终态", async () => {
    const ends: Array<Extract<AgentEvent, { type: "agent_end" }>> = [];
    const chunks: AgentStreamChunk[] = [{ type: "done", stopReason: "stop", usage: { inputTokens: 2, outputTokens: 3 }, durationMs: 7, responseId: "resp-1" }];
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* () { yield "ok"; yield* chunks; },
    });
    agent.subscribe((event) => { if (event.type === "agent_end") ends.push(event); });
    await agent.prompt("old");
    await agent.prompt("new");
    expect(ends[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(agent.state.messages.length).toBeGreaterThan(ends[1]!.messages.length);
  });

  test("error chunk 与抛错都产生 message/turn/agent 完整终态且不执行工具", async () => {
    for (const mode of ["chunk", "throw"] as const) {
      let executions = 0;
      let streams = 0;
      const agent = createAgent({
        includeBuiltins: false,
        emissionPolicy: "direct",
        streamFn: async function* () {
          streams += 1;
          if (streams > 1) { yield "unexpected continuation"; return; }
          yield { type: "tool_call", id: "c1", name: "write", arguments: "{}" };
          if (mode === "chunk") yield { type: "error", error: { code: "provider_error", message: "safe failure" } };
          else throw new Error("safe failure");
        },
      });
      agent.api.registerTool({ name: "write", execute: () => { executions += 1; } });
      const events: AgentEvent[] = [];
      agent.subscribe((event) => { events.push(event); });
      await agent.prompt("go");
      expect(executions).toBe(0);
      expect(events.some((event) => event.type === "message_end" && String(event.message.content).includes("safe failure"))).toBe(true);
      expect(events.some((event) => event.type === "turn_end")).toBe(true);
      expect(events.at(-1)?.type).toBe("agent_end");
    }
  });
});
