import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentMessage, type AgentStreamFn } from "./facade";
import { createJsonlSessionStore } from "./session/jsonl-store";
import type { SessionStore } from "./session/store";

const dirs: string[] = [];

function tempStore(sessionId: string): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "zeta-t17-session-"));
  dirs.push(dir);
  return createJsonlSessionStore({ path: join(dir, "session.jsonl"), sessionId });
}

function contents(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => message.content);
}

function stubStream(onRequest?: (messages: readonly AgentMessage[]) => void): AgentStreamFn {
  return async function* (request) {
    onRequest?.([...(request.messages ?? [])]);
    yield "ok";
    yield { type: "done", stopReason: "stop" } as const;
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("T-17 SessionStore 恢复与崩溃并发（facade 真实 transcript）", () => {
  test("重启续聊证据来自真实 agent 状态：历史只注入一次，system/tool 声明不重复", async () => {
    const store = tempStore("t17-reopen");
    const first = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    await first.prompt("turn-one");
    expect(contents(store.projection().messages)).toContain("turn-one");

    const requests: AgentMessage[][] = [];
    const reopened = createAgent({
      includeBuiltins: false,
      streamFn: stubStream((messages) => requests.push([...messages])),
      sessionStore: store,
    });
    // 证据来自真实 agent 状态，而不是“store 能读盘”。
    expect(contents(reopened.state.messages)).toContain("turn-one");
    expect(contents(reopened.state.messages).filter((content) => content === "turn-one")).toHaveLength(1);
    expect(reopened.state.messages.filter((message) => message.role === "system")).toHaveLength(0);

    await reopened.continue();
    const request = requests[0] ?? [];
    expect(contents(request)).toContain("turn-one");
    expect(contents(request).filter((content) => content === "turn-one")).toHaveLength(1);
    const systems = request.filter((message) => message.role === "system");
    const prompts = systems.filter((message) => String(message.content).includes("Current working directory"));
    expect(prompts).toHaveLength(1);
    expect(systems.filter((message) => String(message.content).includes("tools:")).length).toBeLessThanOrEqual(1);
    expect(contents(reopened.state.messages).filter((content) => content === "turn-one")).toHaveLength(1);
    store.close();
  });

  test("fork/resume/truncate 立即切换真实 transcript，且 fork 不污染原会话", async () => {
    const store = tempStore("t17-branches");
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    await agent.prompt("root");
    const rootId = store.projection().frames.find((frame) => frame.kind === "message")?.id;
    expect(rootId).toBeDefined();
    await agent.prompt("main");

    const forked = await agent.forkSession(rootId);
    expect(contents(agent.state.messages)).toContain("root");
    expect(contents(agent.state.messages)).not.toContain("main");
    await agent.prompt("fork-write");
    expect(contents(agent.sessionStore!.projection().messages)).toContain("fork-write");
    expect(contents(store.projection().messages)).not.toContain("fork-write");
    const originalReopened = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    expect(contents(originalReopened.state.messages)).not.toContain("fork-write");

    agent.resumeSession(rootId!);
    expect(contents(agent.state.messages)).toContain("root");
    expect(contents(agent.state.messages)).not.toContain("fork-write");
    await agent.prompt("resumed-write");
    expect(contents(agent.sessionStore!.projection().messages)).toContain("resumed-write");
    expect(contents(store.projection().messages)).not.toContain("resumed-write");

    const truncated = await agent.truncateSession(rootId!);
    expect(contents(agent.state.messages)).not.toContain("resumed-write");
    await agent.prompt("after-truncate");
    expect(contents(truncated.projection().messages)).toContain("after-truncate");
    expect(contents(store.projection().messages)).not.toContain("after-truncate");
    expect(store.projection().frames.some((frame) => frame.kind === "fork")).toBe(true);
    expect(store.projection().frames.some((frame) => frame.kind === "truncate")).toBe(true);
    agent.sessionStore?.close();
    forked.close();
    truncated.close();
    originalReopened.sessionStore?.close();
    store.close();
  });

  test("committed system/tool 事实只回放计算，工具声明按当前 registry 增量注入", async () => {
    const store = tempStore("t17-tools");
    await store.append({ role: "system", content: "tools: read\nCurrent working directory: /t17" });
    await store.append({ role: "user", content: "old" });

    const requests: AgentMessage[][] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: stubStream((messages) => requests.push([...messages])),
      sessionStore: store,
    });
    agent.api.registerTool({ name: "write", execute: () => "done" });
    await agent.prompt("new");

    const declared = agent.state.messages.filter((message) => message.role === "system");
    expect(declared).toHaveLength(1);
    expect(String(declared[0]?.content)).toContain("tools: write");
    expect(String(declared[0]?.content)).not.toContain("tools: read\n");
    const request = requests[0] ?? [];
    expect(contents(request)).toContain("old");
    expect(contents(request)).toContain("new");
    expect(request.filter((message) => message.role === "system" && String(message.content).includes("tools: read")).length).toBe(0);
    store.close();
  });
});
