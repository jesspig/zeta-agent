import { describe, expect, test } from "bun:test";
import * as facade from "./facade";

describe("T-25 agent facade and plugin assembly", () => {
  test("facade runtime export surface contains only public API", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "DEFAULT_ASSEMBLY",
      "createAgent",
      "defineCompatExtension",
      "defineDurableExtension",
      "listAssembly",
    ]);
  });

  test("default assembly manifest lists builtins, skills and session but no research seams", () => {
    const assembly = facade.listAssembly();

    expect(assembly).toEqual(facade.DEFAULT_ASSEMBLY);
    expect(assembly).toContain("builtin:read");
    expect(assembly).toContain("builtin:bash");
    expect(assembly).toContain("builtin:edit");
    expect(assembly).toContain("builtin:write");
    expect(assembly).toContain("skills:registry");
    expect(assembly).toContain("session:store");

    for (const id of assembly) {
      expect(id).toMatch(/^(builtin|skills|session):/);
      expect(id).not.toMatch(/seam|research|evolution|rsi|evidence|fitness|experience|strategy/i);
    }
  });

  test("compat and durable extension facades normalize to the same AgentPlugin shape", () => {
    const tool = { name: "echo", execute: (input: string) => input };
    const handler = () => {};

    const fromCompat = facade.defineCompatExtension("ext:compat", (api) => {
      api.registerTool(tool);
      api.on("agent_start", handler);
    });
    const fromDurable = facade.defineDurableExtension("ext:durable", {
      tools: [tool],
      hooks: [{ event: "agent_start", handler }],
    });

    expect(fromCompat.kind).toBe("AgentPlugin");
    expect(fromDurable.kind).toBe("AgentPlugin");
    expect(fromCompat.contributions.map((item) => item.kind).sort()).toEqual(["hook", "tool"]);
    expect(fromDurable.contributions.map((item) => item.kind).sort()).toEqual(["hook", "tool"]);
    expect(fromCompat.contributions.find((item) => item.kind === "tool")).toEqual({
      kind: "tool",
      tool,
    });
  });

  test("createAgent exposes prompt/continue/subscribe/abort/waitForIdle and emits events", async () => {
    const agent = facade.createAgent({
      streamFn: async function* () {
        yield "hello";
      },
    });

    expect(typeof agent.prompt).toBe("function");
    expect(typeof agent.continue).toBe("function");
    expect(typeof agent.subscribe).toBe("function");
    expect(typeof agent.abort).toBe("function");
    expect(typeof agent.waitForIdle).toBe("function");

    const seen: string[] = [];
    const dispose = agent.subscribe((event) => {
      seen.push(event.type);
    });

    const messages = await agent.prompt("hi");
    await agent.waitForIdle();

    expect(seen).toContain("agent_start");
    expect(seen).toContain("turn_start");
    expect(seen).toContain("message_start");
    expect(seen).toContain("message_end");
    expect(seen).toContain("agent_end");
    expect(messages.map((item) => item.content)).toContain("hi");
    expect(messages.map((item) => item.content)).toContain("hello");

    const continued = await agent.continue();
    expect(continued.length).toBeGreaterThan(messages.length);

    dispose();
    agent.abort();
    expect(agent.aborted).toBe(true);
  });
});

describe("T-09 createAgent PluginApiSurface 装配", () => {
  test("createAgent 运行时可达 capabilities()/onEffect()/addRedactor()", () => {
    const agent = facade.createAgent();

    expect(typeof agent.capabilities).toBe("function");
    expect(typeof agent.onEffect).toBe("function");
    expect(typeof agent.addRedactor).toBe("function");
  });

  test("capabilities() 返回 security backend 的探测结果副本", () => {
    const agent = facade.createAgent();
    const probed = agent.capabilities();

    expect(probed).toEqual({
      isolation: "active",
      seccomp: "active",
      fsConfinement: "active",
      auditSink: "active",
      egressDefaultDeny: "active",
    });
    probed.isolation = "degraded";
    expect(agent.capabilities().isolation).toBe("active");
  });

  test("onEffect() 注册 handler 并返回可撤销的 disposer", () => {
    const agent = facade.createAgent();
    const seen: string[] = [];
    const stop = agent.onEffect((meta) => {
      seen.push(meta.label);
    });
    expect(typeof stop).toBe("function");

    agent.emitEffect({ label: "root", children: [] });
    expect(seen).toEqual(["root"]);

    stop();
    agent.emitEffect({ label: "again", children: [] });
    expect(seen).toEqual(["root"]);
  });

  test("addRedactor() 经 observability logger 在发送前脱敏，可撤销", () => {
    const emitted: string[] = [];
    const agent = facade.createAgent({
      observability: {
        runId: "run-1",
        sink: (message) => emitted.push(message.message),
      },
    });
    const stop = agent.addRedactor({ match: /sk-[A-Za-z0-9]+/g, replace: "[REDACTED]" });
    expect(typeof stop).toBe("function");

    agent.logger.forFiber("f").info("token sk-abc123 present");
    expect(emitted[0]).toBe("token [REDACTED] present");

    stop();
    agent.logger.forFiber("f").info("token sk-abc123 present");
    expect(emitted[1]).toBe("token sk-abc123 present");
  });

  test("事件日志经 logger sink 旁路输出，且脱敏在写入 sink 前生效", async () => {
    const emitted: string[] = [];
    const agent = facade.createAgent({
      observability: { runId: "run-2", sink: (message) => emitted.push(message.message) },
      streamFn: async function* () {
        yield "token sk-xyz999 present";
      },
    });
    agent.addRedactor({ match: /sk-[A-Za-z0-9]+/g, replace: "[REDACTED]" });

    await agent.prompt("sk-usertoken123");
    await agent.waitForIdle();

    expect(emitted.length).toBeGreaterThan(0);
    for (const message of emitted) {
      expect(message.includes("sk-")).toBe(false);
    }
    expect(emitted.some((message) => message.includes("[REDACTED]"))).toBe(true);
  });
});
