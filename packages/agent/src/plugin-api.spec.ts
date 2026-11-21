import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage, CoreContextLike } from "@zeta-agent/agent-framework";
import { createAgent, type PluginApiSurface } from "./facade";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PING = { name: "ping", execute: () => "pong" };

function markerAgent(script: () => AsyncGenerator<string>): ReturnType<typeof createAgent> {
  return createAgent({
    includeBuiltins: false,
    streamFn: script,
  });
}

describe("T-10 完整 AgentPluginApi 契约", () => {
  test("agent.api 暴露 AgentPluginApi 的全部成员", () => {
    const api: PluginApiSurface = createAgent().api;

    for (const name of [
      "registerTool",
      "onEvent",
      "addConverter",
      "addContextTransform",
      "addBeforeToolCall",
      "addAfterToolCall",
      "addTurnBoundary",
      "addPrepareRequest",
      "addPrepareNextTurn",
      "provideSteering",
      "provideFollowUp",
      "provideStreamFn",
      "declareToolLoadout",
      "useContext",
      "capabilities",
      "onEffect",
      "addRedactor",
      "disposeAll",
    ] as const) {
      expect(typeof api[name]).toBe("function");
    }
    expect(api.events).toBeDefined();
    expect(typeof api.events.on).toBe("function");
    expect(typeof api.events.emit).toBe("function");
  });

  test("registerTool 注册后可从 toolNames 与工具调用通道到达，disposer 精确撤销", async () => {
    const agent = markerAgent(async function* () {
      yield '@@TOOL:ping:{}@@';
    });

    expect(agent.toolNames).not.toContain("ping");
    const stop = agent.api.registerTool(PING);
    expect(agent.toolNames).toContain("ping");

    const messages = await agent.prompt("go");
    const result = messages.find((message) => message.role === "toolResult");
    expect(String(result?.content)).toContain("pong");

    stop();
    expect(agent.toolNames).not.toContain("ping");
    const after = markerAgent(async function* () {
      yield '@@TOOL:ping:{}@@';
    });
    const missing = await after.prompt("go");
    const failed = after.state.messages.find((message) => message.role === "toolResult");
    expect(String(failed?.content)).toContain("TOOL_NOT_FOUND");
  });

  test("onEvent 收到事件，disposer 撤销后不再收到", async () => {
    const agent = createAgent();
    const seen: string[] = [];
    const stop = agent.api.onEvent((event) => {
      seen.push(event.type);
    });

    await agent.prompt("x");
    expect(seen).toContain("agent_start");
    expect(seen).toContain("agent_end");

    const count = seen.length;
    stop();
    await agent.continue();
    expect(seen.length).toBe(count);
  });

  test("addConverter 把原始 chunk 转成 AgentEvent 并接入事件流，disposer 可撤销", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "raw";
      },
    });
    const converted: AgentEvent[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "plugin-converted") {
        converted.push(event);
      }
    });

    const stop = agent.api.addConverter((input) => {
      if (input !== "raw") return undefined;
      return {
        type: "message_update",
        message: { role: "assistant", content: "converted" },
        assistantMessageEvent: { type: "plugin-converted" },
      };
    });

    await agent.prompt("x");
    expect(converted).toHaveLength(1);

    stop();
    await agent.continue();
    expect(converted).toHaveLength(1);
  });

  test("addContextTransform 改写 prepareRequest 产物，disposer 可撤销", async () => {
    let received: unknown;
    const agent = createAgent({
      streamFn: (request) => {
        received = request;
        return (async function* () {
          yield "ok";
        })();
      },
    });

    const stop = agent.api.addContextTransform((context) => ({ ...isRecord(context) ? context : {}, tagged: "yes" }));
    await agent.prompt("x");
    expect(isRecord(received) ? received.tagged : undefined).toBe("yes");

    stop();
    await agent.continue();
    expect(isRecord(received) ? received.tagged : undefined).toBeUndefined();
  });

  test("addBeforeToolCall / addAfterToolCall 环绕工具执行，disposer 可撤销", async () => {
    const calls: string[] = [];
    const agent = markerAgent(async function* () {
      yield '@@TOOL:ping:{}@@';
    });
    agent.api.registerTool(PING);
    const stopBefore = agent.api.addBeforeToolCall(() => {
      calls.push("before");
    });
    const stopAfter = agent.api.addAfterToolCall(() => {
      calls.push("after");
    });

    await agent.prompt("x");
    expect(calls).toEqual(["before", "after"]);

    stopBefore();
    stopAfter();
    calls.length = 0;
    await agent.continue();
    expect(calls).toEqual([]);
  });

  test("addTurnBoundary 在 turn_end 触发，disposer 可撤销", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "ok";
      },
    });
    let boundaries = 0;
    const stop = agent.api.addTurnBoundary(() => {
      boundaries += 1;
    });

    await agent.prompt("x");
    expect(boundaries).toBe(1);
    stop();
    await agent.continue();
    expect(boundaries).toBe(1);
  });

  const newRequestAgent = () =>
    createAgent({
      streamFn: (request) => {
        const seen = isRecord(request) ? request : {};
        return (async function* () {
          yield JSON.stringify(seen);
        })();
      },
    });

  test("addPrepareRequest 改写传给 streamFn 的请求，disposer 可撤销", async () => {
    const agent = newRequestAgent();
    const stop = agent.api.addPrepareRequest((request) => ({ ...isRecord(request) ? request : {}, prepared: 1 }));

    const messages = await agent.prompt("x");
    const assistant = messages.find((message) => message.role === "assistant");
    expect(String(assistant?.content)).toContain('"prepared":1');

    stop();
    const later = await agent.continue();
    const after = [...later].reverse().find((message) => message.role === "assistant");
    expect(String(after?.content)).not.toContain('"prepared":1');
  });

  test("addPrepareNextTurn 在每轮开始时触发，disposer 可撤销", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "ok";
      },
    });
    let turns = 0;
    const stop = agent.api.addPrepareNextTurn(() => {
      turns += 1;
    });

    await agent.prompt("x");
    expect(turns).toBe(1);
    stop();
    await agent.continue();
    expect(turns).toBe(1);
  });

  test("provideSteering 把 source.next() 注入 inbox，disposer 可撤销", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "ok";
      },
    });
    const stop = agent.api.provideSteering({
      name: "steering-source",
      next: () => ({ role: "user", content: "steered" }),
    });

    const messages = await agent.prompt("x");
    expect(messages.some((message) => message.role === "user" && message.content === "steered")).toBe(true);

    stop();
    const added: AgentMessage[] = [];
    const off = agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "user") added.push(event.message);
    });
    await agent.continue();
    off();
    expect(added.some((message) => message.content === "steered")).toBe(false);
  });

  test("provideFollowUp 把 source.next() 注入下一轮 inbox，disposer 可撤销", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "ok";
      },
    });
    const stop = agent.api.provideFollowUp({
      name: "followup-source",
      next: () => ({ role: "user", content: "followed" }),
    });

    const messages = await agent.prompt("x");
    expect(messages.some((message) => message.content === "followed")).toBe(true);

    stop();
    const added: AgentMessage[] = [];
    const off = agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "user") added.push(event.message);
    });
    await agent.continue();
    off();
    expect(added.some((message) => message.content === "followed")).toBe(false);
  });

  test("provideStreamFn 覆盖 options.streamFn，disposer 恢复原流", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "fallback";
      },
    });
    const stop = agent.api.provideStreamFn(() => {
      return (async function* () {
        yield "from-plugin";
      })();
    });

    const first = await agent.prompt("x");
    expect(first.some((message) => String(message.content) === "from-plugin")).toBe(true);

    stop();
    const second = await agent.continue();
    expect(second.some((message) => String(message.content) === "fallback")).toBe(true);
  });

  test("declareToolLoadout 声明工具集，重复声明替换旧集合", async () => {
    const agent = createAgent({ includeBuiltins: false });
    expect(agent.toolNames).toEqual([]);

    agent.api.declareToolLoadout([PING]);
    expect(agent.toolNames).toContain("ping");
    agent.api.declareToolLoadout([]);
    expect(agent.toolNames).not.toContain("ping");
  });

  test("useContext 返回注入的 CoreContextLike，未注入时为 undefined", () => {
    const context: CoreContextLike = {
      get: <T>() => "value" as unknown as T,
      effect: () => () => {},
    };
    expect(createAgent({ coreContext: context }).api.useContext()).toBe(context);
    expect(createAgent().api.useContext()).toBeUndefined();
  });

  test("events 是插件共享 EventBus，可按名收发并撤销", () => {
    const agent = createAgent();
    const seen: string[] = [];
    const off = agent.api.events.on("custom", (event: AgentEvent) => {
      if (event.type === "message_start") seen.push(String(event.message.content));
    });

    const message: AgentMessage = { role: "user", content: "bus-payload" };
    agent.api.events.emit("custom", { type: "message_start", message });
    expect(seen).toEqual(["bus-payload"]);

    off();
    agent.api.events.emit("custom", { type: "message_start", message });
    expect(seen).toEqual(["bus-payload"]);
  });

  test("capabilities/onEffect/addRedactor 经 api 委托到既有后端", () => {
    const agent = createAgent();
    expect(agent.api.capabilities().isolation).toBe("active");

    const seen: string[] = [];
    const stopEffect = agent.api.onEffect((meta) => {
      seen.push(meta.label);
    });
    agent.emitEffect({ label: "via-api", children: [] });
    expect(seen).toEqual(["via-api"]);
    stopEffect();

    const emitted: string[] = [];
    const withSink = createAgent({
      observability: { runId: "api", sink: (message) => emitted.push(message.message) },
    });
    const stopRedactor = withSink.api.addRedactor({ match: /secret/g, replace: "[X]" });
    withSink.logger.forFiber("f").info("a secret here");
    expect(emitted[0]).toBe("a [X] here");
    stopRedactor();
  });

  test("disposeAll 按 LIFO 撤销全部注册，且单个 disposer 幂等", () => {
    const agent = createAgent({ includeBuiltins: false });
    const stopA = agent.api.registerTool(PING);
    const stopB = agent.api.registerTool({ name: "pong-tool", execute: () => "pong" });

    stopA();
    stopA();
    expect(agent.toolNames).not.toContain("ping");
    expect(agent.toolNames).toContain("pong-tool");

    const disposable: PluginApiSurface = agent.api;
    disposable.disposeAll();
    expect(agent.toolNames).toEqual([]);
  });

  test("兼容门面贡献的 tool/hook 在运行时可达", async () => {
    const { defineCompatExtension, defineDurableExtension } = await import("./facade");
    let hookCount = 0;
    const plugin = defineCompatExtension("compat:legacy", (api) => {
      api.registerTool(PING);
      api.on("agent_start", () => {
        hookCount += 1;
      });
    });
    const durable = defineDurableExtension("compat:durable", {
      tools: [{ name: "durable-tool", execute: () => "d" }],
      hooks: [{ event: "agent_end", handler: () => { hookCount += 1; } }],
    });

    const agent = createAgent({
      includeBuiltins: false,
      plugins: [plugin, durable],
      streamFn: async function* () {
        yield '@@TOOL:ping:{}@@';
      },
    });
    const messages = await agent.prompt("x");
    expect(agent.toolNames).toContain("ping");
    expect(agent.toolNames).toContain("durable-tool");
    expect(messages.some((message) => message.role === "toolResult")).toBe(true);
    expect(hookCount).toBe(2);
  });
});
