import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "./facade";
import { createAgent } from "./facade";

describe("系统提示词注入", () => {
  test("请求首条为 system，包含 cwd/platform/tools，且不写入会话状态", async () => {
    let seen: readonly AgentMessage[] = [];
    const agent = createAgent({
      streamFn: async function* (request) {
        seen = request.messages;
        yield "ok";
      },
    });
    const messages = await agent.prompt("hi");
    expect(seen[0]?.role).toBe("system");
    const system = String(seen[0]?.content);
    expect(system).toContain(process.cwd());
    expect(system).toContain(process.platform);
    expect(system).toContain("read");
    expect(system).toContain("Current working directory");
    expect(messages.some((message) => message.role === "system")).toBe(false);
  });

  test("自定义 systemPrompt 覆盖默认值", async () => {
    let seen: readonly AgentMessage[] = [];
    const agent = createAgent({
      systemPrompt: "CUSTOM_PROMPT",
      streamFn: async function* (request) {
        seen = request.messages;
        yield "ok";
      },
    });
    await agent.prompt("hi");
    expect(String(seen[0]?.content)).toBe("CUSTOM_PROMPT");
  });

  test("system 提示词每轮只注入一次", async () => {
    const requests: AgentMessage[][] = [];
    const agent = createAgent({
      streamFn: async function* (request) {
        requests.push([...request.messages]);
        yield "ok";
      },
    });
    await agent.prompt("one");
    await agent.prompt("two");
    for (const messages of requests) {
      expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
    }
    expect(requests[1]?.length).toBeGreaterThan(requests[0]?.length ?? 0);
  });
});
