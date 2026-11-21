import { describe, expect, test } from "bun:test";
import { createAgent, type AgentEvent } from "./facade";

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await Bun.sleep(1);
  }
}

describe("T-09 createAgent 接入 runLoop 的事件契约", () => {
  test("prompt(text) 产出完整且有序的事件序列", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "hel";
        yield "lo";
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("hi");
    await agent.waitForIdle();

    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start", // user
      "message_end", // user
      "message_start", // assistant
      "message_update",
      "message_update",
      "message_end", // assistant
      "turn_end",
      "agent_end",
    ]);

    const assistantEnd = events.find(
      (event) => event.type === "message_end" && event.message.role === "assistant"
    );
    expect(assistantEnd).toBeDefined();
    if (assistantEnd?.type === "message_end") expect(assistantEnd.message.content).toBe("hello");
  });

  test("有 streamFn 时产生携带流式 partial 快照的 message_update", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "A";
        yield "B";
        yield "C";
      },
    });
    const updates: AgentEvent[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_update") updates.push(event);
    });

    await agent.prompt("q");

    expect(updates).toHaveLength(3);
    const deltas: string[] = [];
    for (const event of updates) {
      if (event.type !== "message_update") continue;
      expect(event.message.role).toBe("assistant");
      expect(event.assistantMessageEvent.type).toBe("text_delta");
      deltas.push(String((event.assistantMessageEvent as { delta?: unknown }).delta ?? ""));
    }
    expect(deltas).toEqual(["A", "AB", "ABC"]);
  });

  test("waitForIdle 在 agent_end 的异步 listener 完成后才 resolve（agent_end ≠ idle）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = createAgent({
      streamFn: async function* () {
        yield "x";
      },
    });
    let agentEndEntered = false;
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        agentEndEntered = true;
        await gate;
      }
    });

    const prompting = agent.prompt("hi");
    await waitUntil(() => agentEndEntered);

    let idleResolved = false;
    const idling = agent.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Bun.sleep(5);
    expect(idleResolved).toBe(false);

    release();
    await idling;
    expect(idleResolved).toBe(true);
    await prompting;
  });

  test("工具调用标记产生 tool_execution_start/update/end 与 toolResult 消息", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "calling";
        yield '@@TOOL:read:{"path":"x"}@@';
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("use tool");

    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start", // user
      "message_end", // user
      "message_start", // assistant
      "message_update", // "calling" 累积快照
      "message_update", // 工具标记 chunk 的累积快照
      "message_end", // assistant（工具标记不计入 content）
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start", // toolResult
      "message_end", // toolResult
      "turn_end",
      "agent_end",
    ]);

    const start = events.find((event) => event.type === "tool_execution_start");
    expect(start).toBeDefined();
    if (start?.type === "tool_execution_start") {
      expect(start.toolName).toBe("read");
      expect(start.args).toEqual({ path: "x" });
    }
    const assistantEnd = events.find(
      (event) => event.type === "message_end" && event.message.role === "assistant"
    );
    if (assistantEnd?.type === "message_end") expect(assistantEnd.message.content).toBe("calling");
  });

  test("continue() 不向 inbox 注入 user 消息", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "ok";
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.continue();

    const userMessages = events.filter(
      (event) => event.type === "message_start" && event.message.role === "user"
    );
    expect(userMessages).toHaveLength(0);
  });

  test("abort() 使正在运行的 runLoop 停止流式输出", async () => {
    const releases: Array<() => void> = [];
    const agent = createAgent({
      streamFn: async function* () {
        yield "a";
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        yield "b";
      },
    });

    const prompting = agent.prompt("x");
    await waitUntil(() => releases.length > 0);
    agent.abort();
    const releaseFirst = releases[0];
    if (releaseFirst !== undefined) releaseFirst();

    const messages = await prompting;
    const contents = messages.map((message) => String(message.content));
    expect(contents).toContain("a");
    expect(contents).not.toContain("ab");
  });
});
