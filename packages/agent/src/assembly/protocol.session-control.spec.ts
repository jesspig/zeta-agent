import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWorkspaceStore } from "@zeta-agent/agent-framework";
import { createAgent } from "../facade";
import { createJsonlSessionStore } from "../session/jsonl-store";
import {
  createRuntimeProtocol,
  createStoreSessionControl,
} from "./protocol";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zeta-t18-protocol-"));
  dirs.push(dir);
  const store = createJsonlSessionStore({ path: join(dir, "session.jsonl") });
  return { dir, store };
}

describe("T-18 RuntimeProtocol 真实 load/fork/resume/compact", () => {
  test("四个动作全部来自真实 SessionStore 的 committed frame", async () => {
    const { dir, store } = fixture();
    const workspaceStore = createFileWorkspaceStore({ root: join(dir, "workspace") });
    await store.append({ role: "system", content: "durable-objective-α" });
    const first = await store.append({ role: "user", content: "durable-objective-α" });
    await store.append({ role: "assistant", content: "observed" });

    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield { type: "done", stopReason: "stop" };
      },
    });
    const control = createStoreSessionControl({ store, agent, workspaceStore });
    const protocol = createRuntimeProtocol(agent, store.sessionId, control);

    expect(protocol.sessionControl).toBeDefined();
    const loaded = await control.load(store.sessionId);
    expect(loaded.messages.some((message) => message.content === "durable-objective-α")).toBe(true);
    expect(loaded.leafId).toBe(store.projection().leafId);
    expect(agent.state.messages.some((message) => message.content === "durable-objective-α")).toBe(true);

    const forked = await control.fork(first.frameId);
    expect(forked.sessionId).not.toBe(store.sessionId);
    expect(forked.from).toBe(first.frameId);
    const resumed = await control.resume(first.frameId);
    expect(resumed.frameId).toBe(first.frameId);
    expect(resumed.sessionId).toBe(`resume:${first.frameId}`);

    const compacted = await control.compact(store.sessionId);
    expect(compacted.compacted).toBe(true);
    expect(compacted.uris[0]).toMatch(/^workspace:\/\/\//);
    expect(compacted.frameId).toBe(store.projection().leafId);
    const lineage = store.projection().lineage;
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.recap.objective).toContain("durable-objective-α");
    expect(await workspaceStore.get(compacted.uris[0]!)).toBeDefined();
  });

  test("未注入 store 的协议不暴露会话控制，绝不返回内存 stub", () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield { type: "done", stopReason: "stop" };
      },
    });
    const protocol = createRuntimeProtocol(agent);
    expect(protocol.sessionControl).toBeUndefined();
  });
});
