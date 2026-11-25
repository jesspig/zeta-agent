import { describe, expect, test } from "bun:test";
import {
  AgentPluginManager,
  defineAgentPlugin,
  type AgentEvent,
  type AgentMessage,
  type CoreContextLike,
  type HookEntry,
} from "@zeta-agent/agent-framework";
import { createAgent, type AgentStreamChunk, type PluginApiSurface } from "./facade";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PING = { name: "ping", execute: () => "pong" };

function markerAgent(script: () => AsyncGenerator<string>): ReturnType<typeof createAgent> {
  return createAgent({
    includeBuiltins: false,
    streamFn: script,
    // 测试夹具依赖文本标记工具协议；显式 opt-in，生产默认仍关闭。
    allowTextToolMarkers: true,
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

  test("addPrepareNextTurn 首轮零触发，disposer 可撤销", async () => {
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
    expect(turns).toBe(0); // 首轮严格不进入 step1
    await agent.continue();
    expect(turns).toBe(0); // facade 单轮 continue 不构成后续轮次
    stop();
    await agent.continue();
    expect(turns).toBe(0); // disposer 撤销后保持不变
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
    expect(agent.api.capabilities().isolation).toBe("unsupported");

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
      allowTextToolMarkers: true,
    });
    const messages = await agent.prompt("x");
    expect(agent.toolNames).toContain("ping");
    expect(agent.toolNames).toContain("durable-tool");
    expect(messages.some((message) => message.role === "toolResult")).toBe(true);
    expect(hookCount).toBe(2);
  });
});

/** 生产路径探针：所有注册与执行真实经过注入的 AgentPluginManager。 */
class ProbeManager extends AgentPluginManager {
  readonly events: string[] = [];

  override addHook<I = unknown>(
    chainName: string,
    fn: (input: I, signal?: AbortSignal) => unknown | Promise<unknown>,
    priority?: number,
    name?: string,
    options?: { readonly dependsOn?: readonly string[] }
  ) {
    this.events.push(`add:${chainName}`);
    return super.addHook(chainName, fn, priority, name, options);
  }

  override setLegacy(field: string, fn: (input: unknown) => unknown) {
    this.events.push(`legacy:${field}`);
    return super.setLegacy(field, fn);
  }

  override chain<I = unknown>(
    name: string,
    override?: { readonly rethrow?: boolean }
  ) {
    this.events.push(`chain:${name}`);
    return super.chain<I>(name, override);
  }

  override async run<I>(
    chainName: string,
    input: I,
    signal?: AbortSignal,
    options?: { readonly failClosed?: boolean; readonly reverse?: boolean }
  ): Promise<I> {
    this.events.push(`run:${chainName}`);
    return super.run(chainName, input, signal, options);
  }

  override async runEach<I>(
    chainName: string,
    input: I,
    signal: AbortSignal | undefined,
    visit: (value: unknown, entry: HookEntry<I>) => void | Promise<void>
  ): Promise<void> {
    this.events.push(`runEach:${chainName}`);
    return super.runEach(chainName, input, signal, visit);
  }
}

describe("T-07 生产路径单一 manager 探针", () => {
  const HOOK_CHAINS = [
    "converter",
    "contextTransform",
    "beforeToolCall",
    "afterToolCall",
    "turnBoundary",
    "prepareRequest",
    "prepareNextTurn",
    "steering",
    "followUp",
    "streamFn",
    "wrap",
  ] as const;

  function registerAllHooks(
    agent: ReturnType<typeof createAgent>,
    provider?: () => AsyncIterable<AgentStreamChunk>
  ): void {
    agent.api.addConverter((input) => input === "raw" ? { type: "agent_start" } : undefined);
    agent.api.addContextTransform((input) => input);
    agent.api.addBeforeToolCall(() => undefined);
    agent.api.addAfterToolCall(() => undefined);
    agent.api.addTurnBoundary(() => undefined);
    agent.api.addPrepareRequest((input) => input);
    agent.api.addPrepareNextTurn(() => undefined);
    agent.api.provideSteering({ name: "probe-steering", next: () => undefined });
    agent.api.provideFollowUp({ name: "probe-followUp", next: () => undefined });
    agent.api.provideStreamFn(provider ?? (() => (async function* () { yield "from-provider"; })()));
    agent.api.addWrap("probe-wrap", { handler: () => undefined });
  }

  test("生产路径所有 hook 注册经同一 manager，legacy 字段经 setLegacy 适配", () => {
    const manager = new ProbeManager();
    const agent = createAgent({
      includeBuiltins: false,
      pluginManager: manager,
      loopHooks: {
        prepareRequest: (input) => input,
        prepareNextTurn: () => undefined,
        finishTurn: () => undefined,
        pollFollowUp: () => [],
      },
      streamFn: async function* () { yield "ok"; },
    });
    registerAllHooks(agent);

    for (const chain of HOOK_CHAINS) expect(manager.events).toContain(`add:${chain}`);
    for (const field of ["prepareRequest", "prepareNextTurn", "turnBoundary", "pollFollowUp"]) {
      expect(manager.events).toContain(`legacy:${field}`);
    }
    expect(manager.chain("prepareRequest").snapshot().map((entry) => entry.name))
      .toContain("legacy:prepareRequest");
  });

  test("真实回合中每条 hook 链都由 manager 驱动", async () => {
    const manager = new ProbeManager();
    let streams = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      pluginManager: manager,
    });
    agent.api.registerTool({ name: "ping", execute: () => "pong" });
    registerAllHooks(agent, () => (async function* (): AsyncIterable<AgentStreamChunk> {
      streams += 1;
      if (streams === 1) yield { type: "tool_call", id: "c1", name: "ping", arguments: "{}" };
      else yield "ok";
    })());

    await agent.prompt("go");

    for (const chain of [
      "contextTransform",
      "prepareRequest",
      "steering",
      "followUp",
      "beforeToolCall",
      "afterToolCall",
      "wrap",
      "turnBoundary",
      "prepareNextTurn",
      "pollFollowUp",
    ]) {
      expect(manager.events).toContain(`run:${chain}`);
    }
    expect(manager.events).toContain("runEach:converter");
    expect(manager.events).toContain("chain:streamFn");
  });

  test("legacy loopHooks 在同一链中真实执行", async () => {
    const manager = new ProbeManager();
    const seen: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      pluginManager: manager,
      streamFn: async function* () { yield "ok"; },
      loopHooks: {
        prepareRequest: (request) => { seen.push("legacy-request"); return request; },
        finishTurn: () => { seen.push("legacy-finish"); return undefined; },
      },
    });
    await agent.prompt("x");
    expect(seen).toEqual(["legacy-request", "legacy-finish"]);
    expect(manager.events).toContain("run:prepareRequest");
    expect(manager.events).toContain("run:turnBoundary");
  });

  test("依赖环只让目标插件 FAILED，健康插件 hook 仍执行", async () => {
    const seen: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      allowTextToolMarkers: true,
      plugins: [
        defineAgentPlugin("cyc-a", [{ kind: "wrap", name: "a", dependsOn: ["b"], handler: () => { seen.push("a"); } }]),
        defineAgentPlugin("cyc-b", [{ kind: "wrap", name: "b", dependsOn: ["a"], handler: () => { seen.push("b"); } }]),
        defineAgentPlugin("healthy", [{ kind: "wrap", name: "healthy", handler: () => { seen.push("healthy"); } }]),
      ],
      streamFn: async function* () { yield '@@TOOL:ping:{}@@'; },
    });
    agent.api.registerTool({ name: "ping", execute: () => "pong" });
    expect(agent.pluginInstallations.find((item) => item.plugin.name === "cyc-a")?.status).toBe("FAILED");
    expect(agent.pluginInstallations.find((item) => item.plugin.name === "cyc-b")?.status).toBe("FAILED");
    expect(agent.pluginInstallations.find((item) => item.plugin.name === "healthy")?.status).toBe("ACTIVE");

    await agent.prompt("x");
    expect(seen).toContain("healthy");
    expect(seen).not.toContain("a");
    expect(seen).not.toContain("b");
  });

  test("工具链 fail-closed：hook 抛错阻断工具执行", async () => {
    let executions = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      allowTextToolMarkers: true,
      streamFn: async function* () { yield '@@TOOL:ping:{}@@'; },
    });
    agent.api.registerTool({ name: "ping", execute: () => { executions += 1; return "pong"; } });
    agent.api.addBeforeToolCall(() => { throw new Error("hook-down"); });
    await agent.prompt("x");
    expect(executions).toBe(0);
  });
});
