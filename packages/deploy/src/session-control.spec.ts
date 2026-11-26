import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  createFileWorkspaceStore,
  createJsonlSessionStore,
  type RuntimeProtocol,
} from "@zeta-agent/agent";
import {
  createRpcDispatcher,
  createStoreSessionControl,
  type RpcRequest,
} from "./rpc";
import { startDaemon } from "./daemon";
import { createRemoteClient, createRemoteSessionControl } from "./remote";
import { egressRuleFromUrl } from "@zeta-agent/components";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zeta-t18-rpc-"));
  dirs.push(dir);
  const sessionPath = join(dir, "session.jsonl");
  const store = createJsonlSessionStore({ path: sessionPath });
  return { dir, sessionPath, store };
}

function protocol(): RuntimeProtocol {
  return {
    session: { id: "rpc-session", messages: () => [], reset: () => {} },
    control: { dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }) },
    event: { subscribe: () => () => {} },
    dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
  };
}

function request(id: number, method: string, params: Record<string, unknown> = {}): RpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

describe("T-18 RPC session.* 真实存储与跨进程恢复", () => {
  test("session.load/fork/resume/compact 全部返回真实 store 状态", async () => {
    const { dir, store } = fixture();
    await store.append({ role: "system", content: "rpc-objective-Ω" });
    const first = await store.append({ role: "user", content: "rpc-durable-block" });
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield { type: "done", stopReason: "stop" };
      },
    });
    const dispatcher = createRpcDispatcher({
      protocol: protocol(),
      probes: { readiness: () => true, liveness: () => true, configDigest: () => "d" },
      session: createStoreSessionControl({
        store,
        agent,
        workspaceStore: createFileWorkspaceStore({ root: join(dir, "workspace") }),
      }),
    });

    const loaded = await dispatcher.handle(request(1, "session.load", { sessionId: store.sessionId }));
    expect(loaded.error).toBeUndefined();
    const result = loaded.result as { messages: readonly { content: unknown }[] };
    expect(result.messages.some((message) => message.content === "rpc-durable-block")).toBe(true);

    const forked = await dispatcher.handle(request(2, "session.fork", { frameId: first.frameId }));
    const forkedResult = forked.result as { sessionId: string; from: string };
    expect(forkedResult.from).toBe(first.frameId);
    expect(forkedResult.sessionId).toContain("fork:");

    const resumed = await dispatcher.handle(request(3, "session.resume", { frameId: first.frameId }));
    expect((resumed.result as { frameId: string }).frameId).toBe(first.frameId);

    const compacted = await dispatcher.handle(request(4, "session.compact", { sessionId: store.sessionId }));
    const compactResult = compacted.result as { compacted: boolean; uris: readonly string[]; frameId: string };
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.uris[0]).toMatch(/^workspace:\/\/\//);
    expect(compactResult.frameId).toBe(store.projection().leafId as string);
    expect(store.projection().lineage.length).toBe(1);
  });

  test("remote 适配器经真实 daemon HTTP 操作同一持久 store", async () => {
    const { dir, store } = fixture();
    await store.append({ role: "user", content: "remote-persistent-marker" });
    const daemon = startDaemon({
      token: "t",
      config: { target: "linux-x64" },
      runtime: {
        protocol: protocol(),
        probes: { readiness: () => true, liveness: () => true, configDigest: () => "d" },
        session: createStoreSessionControl({
          store,
          workspaceStore: createFileWorkspaceStore({ root: join(dir, "workspace") }),
        }),
      },
      port: 0,
      allowPlainLoopback: true,
    });
    try {
      const client = createRemoteClient({
        url: daemon.url,
        token: "t",
        egress: { allow: [egressRuleFromUrl(daemon.url)] },
      });
      const control = createRemoteSessionControl(client);
      const loaded = await control.load(store.sessionId);
      expect((loaded.messages ?? []).some((message) => (message as { content?: unknown }).content === "remote-persistent-marker")).toBe(true);
      const compacted = await control.compact(store.sessionId);
      expect(compacted.compacted).toBe(true);
      expect(store.projection().lineage.length).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  test("跨进程重新打开真实 store 可取回消息与压缩血缘（非内存态）", async () => {
    const { sessionPath, store } = fixture();
    await store.append({ role: "user", content: "cross-process-marker" });
    await store.appendRecap(
      {
        objective: "cross-process-objective",
        establishedFacts: [],
        appliedChanges: [],
        verification: [],
        deadEnds: [],
        remainingPlan: [],
      },
      ["workspace:///cross-process-block"],
      { threshold: 1, preTokenCount: 1 }
    );

    const fixturePath = join(import.meta.dir, "..", "..", "agent", "src", "session", "fixtures", "session-reload.mjs");
    const output = execFileSync("bun", [fixturePath, sessionPath], { encoding: "utf8" });
    const reloaded = JSON.parse(output.trim()) as {
      messages: readonly { content: unknown }[];
      lineageCount: number;
      uris: readonly string[];
    };
    expect(reloaded.messages.some((message) => message.content === "cross-process-marker")).toBe(true);
    expect(reloaded.lineageCount).toBe(1);
    expect(reloaded.uris).toContain("workspace:///cross-process-block");
  });
});
