import { describe, expect, test } from "bun:test";
import { createDefaultRuntime } from "../assembly/runtime";
import { createAgent } from "../facade";
import { createProviderBroker } from "./broker";
import type { AgentStreamChunk } from "../facade";

const DONE = { type: "done", stopReason: "stop" } as const;
const FAILURE = { type: "error", error: { code: "server", message: "down", status: 503 } } as const;

function contents(chunks: readonly { content: unknown }[]): unknown[] {
  return chunks.map((item) => item.content);
}

describe("T-09 provider broker 生产路径", () => {
  test("facade 自带 broker：注入 streamFn 的请求也统一经 broker 路由", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "base";
        yield DONE;
      },
    });
    expect(agent.providerBroker).toBeDefined();
    agent.registerProvider("extra", async function* () {
      yield "extra-result";
      yield DONE;
    });
    agent.setProvider("extra");
    const messages = await agent.prompt("switch");
    expect(contents(messages)).toContain("extra-result");
    expect(agent.providerBroker!.resolve({ messages: [], provider: "extra" })).toEqual(["extra"]);
  });

  test("公开工厂可独立注册/路由/fallback，observer 收到 payload/response", async () => {
    const seen: string[] = [];
    const broker = createProviderBroker({
      fallback: ["backup"],
      onRoute: (route) => seen.push(`route:${route}`),
      onPayload: (provider) => seen.push(`payload:${provider}`),
      onResponse: (provider, chunk) => seen.push(`response:${provider}:${chunk.type}`),
      onProviderStreamEvent: (provider, chunk) => {
        seen.push(`event:${provider}:${typeof chunk === "string" ? "text" : (chunk as AgentStreamChunk & { type: string }).type}`);
      },
    });
    broker.register("primary", async function* () {
      yield FAILURE;
    });
    broker.register("backup", async function* () {
      yield "backup-result";
      yield DONE;
    });
    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of broker.stream({ messages: [], provider: "primary" })) chunks.push(chunk);

    expect(chunks).toContain("backup-result");
    expect(broker.resolve({ messages: [], provider: "primary" })).toEqual(["primary", "backup"]);
    expect(seen).toContain("route:primary");
    expect(seen).toContain("route:backup");
    expect(seen).toContain("payload:backup");
    expect(seen).toContain("event:backup:text");
    expect(seen).toContain("response:backup:done");
  });

  test("createDefaultRuntime 装配 broker：热注册/切换不重建 Agent 且 fallback 在生产可达", async () => {
    const seen: string[] = [];
    const runtime = await createDefaultRuntime({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "base-result";
        yield DONE;
      },
      providerFallback: ["backup"],
      providerObservers: {
        onRoute: (route) => seen.push(`route:${route}`),
        onPayload: (provider) => seen.push(`payload:${provider}`),
        onResponse: (provider, chunk) => seen.push(`response:${provider}:${chunk.type}`),
        onProviderStreamEvent: (provider, chunk) => {
          seen.push(`event:${provider}:${typeof chunk === "string" ? "text" : (chunk as AgentStreamChunk & { type: string }).type}`);
        },
      },
    });
    try {
      const agent = runtime.agent;
      expect(runtime.providerBroker).toBeDefined();
      agent.api.registerTool({ name: "kept", execute: () => "kept" });
      const first = await agent.prompt("first");
      expect(contents(first)).toContain("base-result");
      expect(seen).toContain("route:base");
      expect(seen).toContain("response:base:done");

      agent.registerProvider("primary", async function* () {
        yield FAILURE;
      });
      agent.registerProvider("backup", async function* () {
        yield "fallback-result";
        yield DONE;
      });
      agent.setProvider("primary");
      const second = await agent.prompt("second");
      expect(contents(second)).toContain("fallback-result");
      expect(agent).toBe(runtime.agent);
      expect(agent.toolNames).toContain("kept");
      expect(runtime.providerBroker.resolve({ messages: [], provider: "primary" })).toEqual(["primary", "backup"]);
      expect(seen).toContain("route:backup");
      expect(seen).toContain("payload:backup");
      expect(seen).toContain("response:backup:done");
    } finally {
      await runtime.dispose();
    }
  });
});
