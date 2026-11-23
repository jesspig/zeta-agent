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
