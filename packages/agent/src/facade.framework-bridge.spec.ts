import { describe, expect, test } from "bun:test";
import {
  createAgent as frameworkCreateAgent,
  AgentPlugin,
  AgentPluginManager,
  HookChain,
} from "@zeta-agent/agent-framework";
import type {
  AgentPlugin as FacadeAgentPluginType,
  AgentPluginManager as FacadeManagerType,
  HookChain as FacadeHookChainType,
} from "./facade";
import { createAgent as facadeCreateAgent } from "./facade";

describe("T-07 core/facade 同一 manager 语义", () => {
  test("两条生产路径共享 no-throw 归一化、legacy 适配与工具链 fail-closed", async () => {
    const coreManager = new AgentPluginManager();
    const coreSeen: string[] = [];
    coreManager.setLegacy("prepareRequest", (input) => {
      coreSeen.push("core-legacy-chain");
      return input;
    });
    coreManager.addHook("prepareRequest", () => { throw new Error("core-hook-down"); }, 10, "broken");
    coreManager.addHook("prepareRequest", (input) => {
      coreSeen.push("core-healthy");
      return input;
    }, 20, "healthy");
    const core = frameworkCreateAgent({
      pluginManager: coreManager,
      streamFn: async function* () { yield "core"; },
      loopHooks: { prepareRequest: (request) => { coreSeen.push("core-legacy-field"); return request; } },
    });
    await core.prompt("go");
    expect(coreSeen).toContain("core-legacy-field");
    expect(coreSeen).toContain("core-healthy");
    expect(coreManager.chain("prepareRequest").lastFailures).toHaveLength(1);

    const facadeManager = new AgentPluginManager();
    const facadeSeen: string[] = [];
    const facade = facadeCreateAgent({
      includeBuiltins: false,
      pluginManager: facadeManager,
      streamFn: async function* () { yield "facade"; },
    });
    facade.api.addPrepareRequest(() => { throw new Error("facade-hook-down"); });
    facade.api.addPrepareRequest((request) => {
      facadeSeen.push("facade-healthy");
      return request;
    });
    await facade.prompt("go");
    expect(facadeSeen).toContain("facade-healthy");
    expect(facadeManager.chain("prepareRequest").lastFailures).toHaveLength(1);

    facadeManager.addHook("beforeToolCall", () => { throw new Error("strict-chain"); }, 10, "strict");
    await expect(facadeManager.run("beforeToolCall", {}, undefined, { failClosed: true }))
      .rejects.toThrow("strict-chain");
  });
});

describe("T-02 双路径导入与行为归位", () => {
  test("两条路径都能导入 createAgent 与插件管线符号", () => {
    expect(typeof frameworkCreateAgent).toBe("function");
    expect(typeof facadeCreateAgent).toBe("function");
    expect(AgentPlugin.kind).toBe("AgentPlugin");
    expect(typeof AgentPluginManager).toBe("function");
    expect(typeof HookChain).toBe("function");

    // 类型经旧路径重导出；类型在运行时被擦除，故用类型标注验证其可导入性。
    type BridgeTypes = [FacadeAgentPluginType, FacadeManagerType, FacadeHookChainType];
    const typeProbe: BridgeTypes | undefined = undefined;
    expect(typeProbe).toBeUndefined();
  });

  test("agent-framework 的通用 createAgent 可驱动带工具的完整回合", async () => {
    const agent = frameworkCreateAgent({
      streamFn: async function* () {
        yield "framework-core";
      },
      tools: [{ name: "ping", execute: () => "pong" }],
    });
    expect(agent.toolNames).toContain("ping");
    const messages = await agent.prompt("go");
    expect(messages.some((message) => String(message.content) === "framework-core")).toBe(true);
    expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);
  });

  test("旧路径 createAgent 行为不变：工具、事件流与插件 API 仍可达", async () => {
    const agent = facadeCreateAgent({
      includeBuiltins: false,
      allowTextToolMarkers: true,
      streamFn: async function* () {
        yield '@@TOOL:ping:{}@@';
      },
    });
    const stop = agent.api.registerTool({ name: "ping", execute: () => "pong" });
    const seen: string[] = [];
    const off = agent.subscribe((event) => {
      seen.push(event.type);
    });

    const messages = await agent.prompt("go");
    expect(seen).toContain("agent_start");
    expect(seen).toContain("agent_end");
    expect(messages.some((message) => message.role === "toolResult" && String(message.content) === "pong")).toBe(true);

    stop();
    off();
    expect(agent.toolNames).not.toContain("ping");
  });
});
