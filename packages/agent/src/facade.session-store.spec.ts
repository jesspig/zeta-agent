import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "./facade";
import { createJsonlSessionStore } from "./session/jsonl-store";
import type { SessionStore } from "./session/store";

const dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-facade-store-"));
  dirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function stubStream() {
  return async function* () {
    yield "ok";
  };
}

describe("T-11 facade 持久化注入", () => {
  test("agent_end listener 先落盘，prompt resolve 前可重开", async () => {
    const path = tempPath();
    const store = createJsonlSessionStore({ path, sessionId: "facade-reopen" });
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });

    let reopened: SessionStore | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    agent.subscribe(async (event) => {
      if (event.type !== "agent_end") return;
      reopened = createJsonlSessionStore({ path });
      expect(reopened.projection().messages.map((item) => item.content)).toContain("persisted");
      release?.();
    });

    let settled = false;
    const prompt = agent.prompt("persisted").then((messages) => {
      settled = true;
      return messages;
    });
    await gate;
    expect(settled).toBe(false);
    expect(reopened?.projection().messages.map((item) => item.content)).toContain("persisted");
    release?.();
    await prompt;
    expect(settled).toBe(true);
    expect(agent.sessionStore).toBe(store);
    store.close();
    reopened?.close();
  });

  test("await 的 listener 未完成前 prompt 不 resolve", async () => {
    const path = tempPath();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createJsonlSessionStore({
      path,
      faults: {
        beforeCommit: async () => {
          await gate;
        },
      },
    });
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream(), sessionStore: store });
    let settled = false;
    const prompt = agent.prompt("slow").then(
      (messages) => {
        settled = true;
        return messages;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      }
    );
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release?.();
    await prompt;
    expect(settled).toBe(true);
    expect(store.projection().messages.map((item) => item.content)).toContain("slow");
    store.close();
  });

  test("未注入 sessionStore 时保持零回归", async () => {
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream() });
    expect(agent.sessionStore).toBeUndefined();
    const messages = await agent.prompt("no-store");
    expect(messages.map((item) => item.content)).toContain("no-store");
  });
});
