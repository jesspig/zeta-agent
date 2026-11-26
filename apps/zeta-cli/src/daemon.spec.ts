import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget, startDaemon } from "@zeta-agent/deploy";
import { createMemorySessionControl, type RpcRuntime } from "@zeta-agent/deploy";
import { createJsonlSessionStore, type RuntimeProtocol } from "@zeta-agent/agent";
import { parseArgs } from "./args";
import { createCliRpcRuntime, startCliDaemon } from "./daemon";
import { createProbeHandle } from "./probes";
import { executeRemoteFrames } from "./remote";
import { createStdoutWriter } from "@zeta-agent/deploy";

function protocol(): RuntimeProtocol {
  return {
    session: { id: "session-1", messages: () => [], reset: () => {} },
    control: { dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }) },
    event: { subscribe: () => () => {} },
    dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
  };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function bundle() {
  const target = hostTarget() ?? "linux-x64";
  const dir = mkdtempSync(join(tmpdir(), "zeta-cli-daemon-"));
  dirs.push(dir);
  return {
    runtime: { protocol: protocol() },
    sessionStore: createJsonlSessionStore({ path: join(dir, "session.jsonl") }),
    probes: createProbeHandle(
      {
        target,
        rootFiber: { state: { kind: "ACTIVE" } },
        profile: "local-safe",
        manifest: {},
        protocol: { session: { id: "session-1" } },
      },
      { target, profile: "local-safe" }
    ),
  };
}

function bundle_without_store() {
  const { sessionStore: _omitted, ...rest } = bundle() as ReturnType<typeof bundle> & { sessionStore?: unknown };
  void _omitted;
  return rest;
}

describe("T-21 CLI daemon / remote / RPC 接线", () => {
  test("--daemon/--remote、--endpoint、--token 解析", () => {
    const daemon = parseArgs(["--daemon", "--token", "t"]);
    expect(daemon.mode).toBe("daemon");
    expect(daemon.token).toBe("t");
    const remote = parseArgs(["--remote", "--endpoint", "http://127.0.0.1:4100", "--token", "t"]);
    expect(remote.mode).toBe("remote");
    expect(remote.endpoint).toBe("http://127.0.0.1:4100");
  });

  test("缺少真实 SessionStore 时 CLI 控制面失败关闭，不用内存 stub 冒充", () => {
    expect(() => createCliRpcRuntime(bundle_without_store())).toThrow("SESSION_STORE_REQUIRED");
  });

  test("CLI daemon 真实启动并响应 RPC 帧", async () => {
    const handle = startCliDaemon(parseArgs(["--daemon", "--token", "t"]), bundle(), { port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    const response = await fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { text: "hi" } }),
    });
    const reply = (await response.json()) as Record<string, unknown>;
    expect(reply.result).toMatchObject({ ok: true, action: "prompt" });
    await handle.stop();
  });

  test("CLI daemon 的 session.* 经真实 SessionStore 返回持久化消息", async () => {
    const b = bundle();
    await b.sessionStore!.append({ role: "user", content: "cli-persistent-marker" });
    const handle = startCliDaemon(parseArgs(["--daemon", "--token", "t"]), b, { port: 0 });
    try {
      const response = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "session.load",
          params: { sessionId: b.sessionStore!.sessionId },
        }),
      });
      const reply = (await response.json()) as { error?: unknown; result?: { messages?: readonly { content?: unknown }[] } };
      expect(reply.error).toBeUndefined();
      expect(reply.result?.messages?.some((message) => message.content === "cli-persistent-marker")).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  test("CLI remote 把远程响应写入 stdout writer，错误不污染 stdout", async () => {
    const runtime: RpcRuntime = {
      protocol: protocol(),
      probes: { readiness: () => true, liveness: () => true, configDigest: () => "digest-1" },
      session: createMemorySessionControl(),
    };
    const daemon = startDaemon({
      token: "t",
      config: { target: "linux-x64" },
      runtime,
      port: 0,
      allowPlainLoopback: true,
    });
    const out: string[] = [];
    const err: string[] = [];
    const writer = createStdoutWriter({
      write: (chunk) => {
        out.push(chunk);
        return true;
      },
      diagnostic: (line) => err.push(line),
    });
    const code = await executeRemoteFrames(
      parseArgs([
        "--remote",
        "--endpoint",
        daemon.url,
        "--token",
        "t",
        '{"jsonrpc":"2.0","id":1,"method":"health"}',
      ]),
      writer
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ id: 1, result: { live: true } });
    expect(err).toEqual([]);
    await daemon.stop();
  });

  test("CLI 注入 runtimeFactory/autoRestart，故障后自动重建并提升代次", async () => {
    let created = 0;
    const handle = startCliDaemon(parseArgs(["--daemon", "--token", "t"]), bundle(), {
      port: 0,
      runtimeFactory: () => {
        created += 1;
        return createCliRpcRuntime(bundle());
      },
      autoRestart: true,
      heartbeatMs: 10,
    });
    try {
      const before = handle.generation;
      handle.fault();
      const deadline = Date.now() + 5000;
      while (handle.restartCount === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(handle.restartCount).toBe(1);
      expect(created).toBe(1);
      expect(handle.generation).toBeGreaterThan(before);
    } finally {
      await handle.stop();
    }
  });
});
