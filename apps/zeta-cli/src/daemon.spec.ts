import { describe, expect, test } from "bun:test";
import { hostTarget, startDaemon } from "@zeta-agent/deploy";
import { createMemorySessionControl, type RpcRuntime } from "@zeta-agent/deploy";
import type { RuntimeProtocol } from "@zeta-agent/agent";
import { parseArgs } from "./args";
import { startCliDaemon } from "./daemon";
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

function bundle() {
  const target = hostTarget() ?? "linux-x64";
  return {
    runtime: { protocol: protocol() },
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

describe("T-21 CLI daemon / remote / RPC 接线", () => {
  test("--daemon/--remote、--endpoint、--token 解析", () => {
    const daemon = parseArgs(["--daemon", "--token", "t"]);
    expect(daemon.mode).toBe("daemon");
    expect(daemon.token).toBe("t");
    const remote = parseArgs(["--remote", "--endpoint", "http://127.0.0.1:4100", "--token", "t"]);
    expect(remote.mode).toBe("remote");
    expect(remote.endpoint).toBe("http://127.0.0.1:4100");
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
});
