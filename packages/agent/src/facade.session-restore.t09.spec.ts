import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentMessage, type AgentStreamFn } from "./facade";
import { createJsonlSessionStore } from "./session/jsonl-store";
import type { SessionStore } from "./session/store";

const dirs: string[] = [];

function tempStore(sessionId: string): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "zeta-t09-session-"));
  dirs.push(dir);
  return createJsonlSessionStore({ path: join(dir, "session.jsonl"), sessionId });
}

function contents(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => message.content);
}

function stubStream(): AgentStreamFn {
  return async function* () {
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

describe("T-09 SessionStore transcript 单源", () => {
  test("重开 Agent 恢复 state.messages，continue/prompt 携带历史且不重复注入 system", async () => {
    const store = tempStore("t09-reopen");
    const first = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    await first.prompt("restore-marker");
    expect(store.projection().messages.length).toBeGreaterThan(0);

    const requests: AgentMessage[][] = [];
    const reopened = createAgent({
      includeBuiltins: false,
      streamFn: async function* (request) {
        requests.push([...request.messages]);
        yield "continued";
        yield { type: "done", stopReason: "stop" } as const;
      },
      sessionStore: store,
    });
    expect(contents(reopened.state.messages)).toContain("restore-marker");

    await reopened.continue();
    expect(contents(requests[0] ?? [])).toContain("restore-marker");
    const systems = (requests[0] ?? []).filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    expect(contents(reopened.state.messages).filter((content) => content === "restore-marker")).toHaveLength(1);
    store.close();
  });

  test("resume/fork/truncate 改变真实 Agent transcript，后续写入落到新分支", async () => {
    const store = tempStore("t09-branches");
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    await agent.prompt("one");
    const frames = store.projection().frames.filter((frame) => frame.kind === "message");
    const firstId = frames[0]!.id;
    await agent.prompt("two");

    agent.resumeSession(firstId);
    expect(contents(agent.state.messages)).toEqual(["one"]);
    expect(agent.sessionStore).not.toBe(store);
    await agent.prompt("resumed");
    expect(contents(agent.sessionStore!.projection().messages)).toContain("resumed");

    const forked = await agent.forkSession(firstId);
    expect(contents(agent.state.messages)).toEqual(["one"]);
    await agent.prompt("fork-only");
    expect(contents(agent.sessionStore!.projection().messages)).toContain("fork-only");
    expect(contents(store.projection().messages)).not.toContain("fork-only");

    const truncated = await agent.truncateSession(firstId);
    expect(contents(agent.state.messages)).toEqual(["one"]);
    await agent.prompt("after-truncate");
    expect(contents(truncated.projection().messages)).toContain("after-truncate");
    expect(contents(store.projection().messages)).not.toContain("after-truncate");
    agent.sessionStore?.close();
    store.close();
  });

  test("committed 工具声明只回放计算，不重复注入，delta 与真实 registry 一致", async () => {
    const store = tempStore("t09-tools");
    await store.append({ role: "system", content: "tools: read" });
    await store.append({ role: "user", content: "old" });

    let requestMessages: readonly AgentMessage[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (request) {
        requestMessages = request.messages;
        yield "ok";
        yield { type: "done", stopReason: "stop" } as const;
      },
      sessionStore: store,
    });
    agent.api.registerTool({ name: "write", execute: () => "done" });
    await agent.prompt("new");

    const declared = agent.state.messages.filter((message) => message.role === "system");
    expect(declared).toHaveLength(1);
    expect(String(declared[0]?.content)).toContain("tools: write");
    expect(String(declared[0]?.content)).not.toContain("tools: read\n");
    expect(requestMessages.filter((message) => message.role === "system").length).toBeGreaterThanOrEqual(1);
    expect(requestMessages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n")).toContain("Current working directory");
    store.close();
  });
});
