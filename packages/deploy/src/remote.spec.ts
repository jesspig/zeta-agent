import { describe, expect, test } from "bun:test";
import { startDaemon, type DaemonOptions } from "./daemon";
import { createMemorySessionControl, type RpcRuntime } from "./rpc";
import { createRemoteBackend, createRemoteClient, createRemoteSidecar, GRPC_STATUS, toGrpcStatus } from "./remote";
import type { RuntimeProtocol } from "@zeta-agent/agent";
import { egressRuleFromUrl } from "@zeta-agent/components";

function makeRuntime(): RpcRuntime {
  const protocol: RuntimeProtocol = {
    session: { id: "session-1", messages: () => [], reset: () => {} },
    control: { dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }) },
    event: { subscribe: () => () => {} },
    dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
  };
  return {
    protocol,
    probes: { readiness: () => true, liveness: () => true, configDigest: () => "digest-1" },
    session: createMemorySessionControl(),
    methods: {
      "backend.run": async (params) => ({
        exitCode: 0,
        stdout: String(params.argv ?? []),
        stderr: "",
        isolated: "remote",
      }),
    },
  };
}

function options(partial: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    token: "test-token",
    config: { target: "linux-x64" },
    runtime: makeRuntime(),
    port: 0,
    ...partial,
  };
}

describe("T-21 remote SDK / gRPC 语义", () => {
  test("真实 daemon HTTP 上全套远程方法可用", async () => {
    const daemon = startDaemon(options());
    const client = createRemoteClient({
      url: daemon.url,
      token: "test-token",
      egress: { allow: [egressRuleFromUrl(daemon.url)] },
    });
    expect((await client.readiness()).result).toBe(true);
    expect((await client.liveness()).result).toBe(true);
    expect((await client.configDigest()).result).toBe("digest-1");
    expect((await client.health()).result).toMatchObject({ ready: true, live: true });
    expect((await client.prompt("hi")).result).toMatchObject({ ok: true, action: "prompt" });
    expect((await client.steer({ role: "user", content: "s" })).result).toMatchObject({ action: "steer" });
    expect((await client.followUp({ role: "user", content: "f" })).result).toMatchObject({ action: "followUp" });
    expect((await client.cancel()).result).toMatchObject({ action: "abort" });
    expect((await client.load("s1")).result).toMatchObject({ sessionId: "s1" });
    expect((await client.fork("f1")).result).toMatchObject({ from: "f1" });
    expect((await client.resume("f2")).result).toMatchObject({ frameId: "f2" });
    expect((await client.compact("s1")).result).toMatchObject({ compacted: true });
    await daemon.stop();
  });

  test("gRPC 风格状态码映射与陈旧代次拒绝", async () => {
    expect(GRPC_STATUS.OK).toBe(0);
    expect(toGrpcStatus({ jsonrpc: "2.0", id: 1, result: true })).toBe(GRPC_STATUS.OK);
    expect(toGrpcStatus({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } })).toBe(GRPC_STATUS.NOT_FOUND);
    expect(toGrpcStatus({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } })).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    expect(toGrpcStatus({ jsonrpc: "2.0", id: 1, error: { code: -32003, message: "x" } })).toBe(GRPC_STATUS.PERMISSION_DENIED);

    const daemon = startDaemon(options());
    const stale = createRemoteClient({
      url: daemon.url,
      token: "test-token",
      generation: daemon.generation - 1,
      egress: { allow: [egressRuleFromUrl(daemon.url)] },
    });
    await expect(stale.readiness()).rejects.toThrow(/STALE_GENERATION/);
    await daemon.stop();
  });

  test("sidecar 复用 T-14 凭证与 egress：注入 Authorization、拒绝未放行目标", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const sidecar = createRemoteSidecar({
      url: "http://127.0.0.1:4100",
      token: "rpc-token",
      secret: {
        name: "provider",
        secret: "s3cr3t",
        binding: { scheme: "http", host: "127.0.0.1", port: 4100 },
      },
      egress: { allow: [{ host: "127.0.0.1", port: 4100 }] },
      fetch: fakeFetch,
    });
    expect((await sidecar.client.call("readiness")).result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer s3cr3t");
    expect(JSON.stringify(sidecar.credential)).not.toContain("s3cr3t");

    const blocked = createRemoteSidecar({
      url: "http://127.0.0.1:4100",
      token: "rpc-token",
      secret: {
        name: "provider",
        secret: "s3cr3t",
        binding: { scheme: "http", host: "127.0.0.1", port: 4100 },
      },
      egress: { allow: [] },
      fetch: fakeFetch,
    });
    await expect(blocked.client.call("readiness")).rejects.toThrow(/EGRESS_DENIED/);
    expect(calls).toHaveLength(1);
  });

  test("remote 默认无 allow 规则配置错误；显式 allow 才走统一出站入口", async () => {
    const { createOutboundClient } = await import("@zeta-agent/components");
    const calls: string[] = [];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), { status: 200 });
    }) as typeof fetch;

    const denied = createOutboundClient({ egress: { allow: [] }, fetch: fakeFetch });
    await expect(createRemoteClient({
      url: "http://127.0.0.1:4200",
      token: "test-token",
      outbound: denied,
    }).readiness()).rejects.toThrow("EGRESS_ALLOW_REQUIRED");
    expect(calls).toEqual([]);

    const allowed = createOutboundClient({
      egress: { allow: [{ host: "127.0.0.1", port: 4200 }] },
      fetch: fakeFetch,
    });
    expect((await createRemoteClient({
      url: "http://127.0.0.1:4200",
      token: "test-token",
      outbound: allowed,
    }).readiness()).result).toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:4200/rpc"]);

    const redirectFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://evil.test/rpc" } });
    }) as typeof fetch;
    const redirectOutbound = createOutboundClient({
      egress: { allow: [{ host: "127.0.0.1", port: 4200 }] },
      fetch: redirectFetch,
    });
    await expect(createRemoteClient({
      url: "http://127.0.0.1:4200",
      token: "test-token",
      outbound: redirectOutbound,
    }).readiness()).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(2);
  });

  test("remote 注入裸 fetchImpl 无 allow 时拒绝；配置 allow 后走该 transport 且逐跳受控", async () => {
    const calls: string[] = [];
    const bareFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), { status: 200 });
    }) as typeof fetch;

    await expect(createRemoteClient({
      url: "http://127.0.0.1:4300",
      token: "test-token",
      fetch: bareFetch,
    }).readiness()).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    expect(calls).toEqual([]);

    let first = true;
    const redirectFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      if (first) {
        first = false;
        return new Response(null, { status: 302, headers: { location: "http://evil.test/rpc" } });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), { status: 200 });
    }) as typeof fetch;
    const allow = { allow: [{ host: "127.0.0.1", port: 4300 }] };
    await expect(createRemoteClient({
      url: "http://127.0.0.1:4300",
      token: "test-token",
      egress: allow,
      fetch: redirectFetch,
    }).readiness()).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toEqual(["http://127.0.0.1:4300/rpc"]);

    expect((await createRemoteClient({
      url: "http://127.0.0.1:4300",
      token: "test-token",
      egress: allow,
      fetch: bareFetch,
    }).readiness()).result).toBe(true);
    expect(calls.at(-1)).toBe("http://127.0.0.1:4300/rpc");
  });

  test("远程 backend 实现 ExecutionBackend 并经 RPC 执行", async () => {
    const daemon = startDaemon(options());
    const client = createRemoteClient({
      url: daemon.url,
      token: "test-token",
      egress: { allow: [egressRuleFromUrl(daemon.url)] },
    });
    const backend = createRemoteBackend({ client, name: "remote-test" });
    expect(backend.name).toBe("remote-test");
    expect(backend.capabilities().egressDefaultDeny).toBe("active");
    const result = await backend.run({ argv: ["echo", "hi"] });
    expect(result).toMatchObject({ exitCode: 0, stdout: "echo,hi", isolated: "remote" });
    backend.dispose();
    await daemon.stop();
  });
});
