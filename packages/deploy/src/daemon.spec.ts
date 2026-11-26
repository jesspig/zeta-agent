import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { createControlFence } from "./control-lease";
import { createEventHub, startDaemon, type DaemonEvent, type DaemonOptions } from "./daemon";
import { computeDaemonConfigDigest } from "./config-digest";
import { createMemorySessionControl, type RpcRuntime } from "./rpc";
import { createRuntimeProbeSource, type AgentRuntimeLike } from "./runtime-probes";
import { createTokenVerifier } from "./token";
import type { RuntimeProtocol } from "@zeta-agent/agent";

function makeRuntime(): RpcRuntime {
  const protocol: RuntimeProtocol = {
    session: { id: "session-1", messages: () => [], reset: () => {} },
    control: {
      dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
    },
    event: { subscribe: () => () => {} },
    dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
  };
  return {
    protocol,
    probes: { readiness: () => true, liveness: () => true, configDigest: () => "digest-1" },
    session: createMemorySessionControl(),
  };
}

function options(partial: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    token: "test-token",
    config: { target: "linux-x64", port: 0 },
    runtime: makeRuntime(),
    port: 0,
    allowPlainLoopback: true,
    ...partial,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_FOR_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface IpcClient {
  send(message: unknown): void;
  close(): void;
}

async function connectIpc(port: number, onFrame: (frame: Record<string, unknown>) => void): Promise<IpcClient> {
  return new Promise<IpcClient>((resolve, reject) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          settled = true;
          resolve({
            send(message) {
              socket.write(`${JSON.stringify(message)}\n`);
            },
            close() {
              socket.end();
            },
          });
        },
        data(_socket, data) {
          buffer += decoder.decode(data, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
            if (line.length === 0) continue;
            try {
              onFrame(JSON.parse(line) as Record<string, unknown>);
            } catch {
              // 噪声帧忽略。
            }
          }
        },
        error(_socket, error) {
          if (!settled) reject(error);
        },
      },
    }).catch((error: unknown) => {
      if (!settled) reject(error);
    });
  });
}

function rpcBody(id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "prompt", params: { text: "hello" } });
}

describe("T-21 daemon 实际启动与控制面", () => {
  test("HTTP 真实监听：探针公开、/rpc 需 token、响应可解析", async () => {
    const daemon = startDaemon(options());
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.ipcPort).toBeGreaterThan(0);

    const health = await fetch(`${daemon.url}/health`).then((response) => response.json());
    expect(health).toMatchObject({
      ready: true,
      live: true,
      digest: computeDaemonConfigDigest({ target: "linux-x64", port: 0 }, "digest-1"),
    });

    const denied = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpcBody(1),
    });
    expect(denied.status).toBe(401);

    const granted = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: rpcBody(2),
    });
    expect(granted.status).toBe(200);
    const grantedReply = (await granted.json()) as Record<string, unknown>;
    expect(grantedReply.result).toMatchObject({ ok: true, action: "prompt" });
    await daemon.stop();
  });

  test("IPC 心跳、多客户端、事件广播与陈旧代次栅栏", async () => {
    const daemon = startDaemon(options());
    const seenA: Record<string, unknown>[] = [];
    const seenB: Record<string, unknown>[] = [];
    let clientA: IpcClient | undefined;
    let clientB: IpcClient | undefined;
    try {
      clientA = await connectIpc(daemon.ipcPort, (frame) => seenA.push(frame));
      clientB = await connectIpc(daemon.ipcPort, (frame) => seenB.push(frame));
      clientA.send({ kind: "hello", token: "test-token", generation: daemon.generation });
      clientB.send({ kind: "hello", token: "test-token", generation: daemon.generation });
      await waitFor(() => seenA.some((frame) => frame.kind === "hello.ack") && seenB.some((frame) => frame.kind === "hello.ack"));
      expect(daemon.clients).toBe(2);

      clientA.send({ kind: "heartbeat", token: "test-token", generation: daemon.generation, seq: 1 });
      await waitFor(() => seenA.some((frame) => frame.kind === "heartbeat.ack" && frame.seq === 1));
      clientA.send({ kind: "heartbeat", token: "test-token", generation: daemon.generation - 1, seq: 2 });
      await waitFor(() => seenA.some((frame) => frame.kind === "error" && frame.error === "STALE_GENERATION"));

      daemon.emit({ type: "test.event", value: 7 });
      await waitFor(() => seenA.some((frame) => frame.kind === "event") && seenB.some((frame) => frame.kind === "event"));
      expect(seenA.find((frame) => frame.kind === "event")?.event).toMatchObject({ type: "test.event", value: 7 });
    } finally {
      clientA?.close();
      clientB?.close();
      await daemon.stop();
    }
  }, 30_000);

  test("故障自动重启：重建 runtime、提升代次、计数", async () => {
    let created = 0;
    const daemon = startDaemon(
      options({
        runtimeFactory: () => {
          created += 1;
          return makeRuntime();
        },
        autoRestart: true,
        heartbeatMs: 10,
      })
    );
    const before = daemon.generation;
    daemon.fault();
    await waitFor(() => daemon.generation > before);
    expect(created).toBe(1);
    expect(daemon.restartCount).toBe(1);
    expect(daemon.liveness()).toBe(true);
    await daemon.stop();
  });

  test("graceful handover：事件不丢、旧进程释放控制租约、只有一个权威 holder", async () => {
    const hub = createEventHub();
    const fence = createControlFence();
    const daemon = startDaemon(options({ hub, fence, owner: "daemon-old" }));
    const observed: DaemonEvent[] = [];
    hub.subscribe((event) => observed.push(event));
    daemon.emit({ type: "before" });

    const successor = await daemon.replace({ owner: "daemon-new" });
    hub.emit({ type: "after" });

    expect(successor.generation).toBeGreaterThan(daemon.generation);
    expect(daemon.liveness()).toBe(false);
    expect(successor.liveness()).toBe(true);
    expect(successor.fence.holder).toBe("daemon-new");
    expect(successor.lease?.generation).toBe(successor.generation);
    expect(observed.map((event) => event.type).filter((type) => type === "before" || type === "after")).toEqual([
      "before",
      "after",
    ]);
    expect(observed.every((event, index) => index === 0 || event.seq > observed[index - 1]!.seq)).toBe(true);
    await successor.stop();
  });

  test("共享 fence 时第二个 daemon 不双启动： standby 拒绝 RPC", async () => {
    const fence = createControlFence();
    const first = startDaemon(options({ fence, owner: "first" }));
    const second = startDaemon(options({ fence, owner: "second" }));
    expect(first.lease).toBeDefined();
    expect(second.lease).toBeUndefined();

    const response = await fetch(`${second.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: rpcBody(3),
    });
    const standbyReply = (await response.json()) as { error?: { code?: number } };
    expect(standbyReply.error?.code).toBe(-32003);
    await second.stop();
    await first.stop();
  });
});

describe("T-16 daemon 租约/探针/TLS 硬化", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function probeRuntime(sessionId: string): AgentRuntimeLike {
    return {
      target: "linux-x64",
      rootFiber: { state: { kind: "ACTIVE" } } as AgentRuntimeLike["rootFiber"],
      profile: "local-safe",
      manifest: { tools: ["read"] },
      protocol: { session: { id: sessionId } },
    };
  }

  test("定时器跨多个 TTL 周期续租，租约持续 active 且 RPC 一直可服务", async () => {
    let clock = 1000;
    const daemon = startDaemon(
      options({ now: () => clock, leaseTtlMs: 60, leaseRenewMs: 10, heartbeatMs: 10 })
    );
    try {
      for (let cycle = 1; cycle <= 5; cycle += 1) {
        clock += 20;
        await sleep(25);
        const reply = await daemon.rpc({ jsonrpc: "2.0", id: cycle, method: "prompt", params: { text: "hello" } });
        expect(reply.error).toBeUndefined();
        expect(daemon.readiness()).toBe(true);
        expect(daemon.lease?.active).toBe(true);
      }
      expect(daemon.health().renewals).toBeGreaterThanOrEqual(4);
      expect(daemon.health().failures).toBe(0);
      expect(daemon.health().leasePhase).toBe("active");
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  test("租约续租失败立即 readiness=false、/ready 返回 503、RPC 停止", async () => {
    let clock = 1000;
    const daemon = startDaemon(
      options({ now: () => clock, leaseTtlMs: 100, leaseRenewMs: 10, heartbeatMs: 10, leaseAutoRecover: false })
    );
    try {
      clock = 1300;
      await sleep(35);
      const response = await fetch(`${daemon.url}/ready`);
      expect(response.status).toBe(503);
      expect((await response.json()) as { ready: boolean }).toEqual({ ready: false });
      expect(daemon.readiness()).toBe(false);
      const reply = await daemon.rpc({ jsonrpc: "2.0", id: 1, method: "prompt", params: { text: "hello" } });
      expect(reply.error?.code).toBe(-32003);
      expect(daemon.health().leasePhase).toBe("expired");
    } finally {
      await daemon.stop();
    }
  });

  test("readiness 聚合 runtime 关键依赖，未 ready 时 /health 与 /ready 均 503", async () => {
    const base = makeRuntime();
    const daemon = startDaemon(
      options({ runtime: { ...base, probes: { ...base.probes, readiness: () => false } } })
    );
    try {
      expect(daemon.readiness()).toBe(false);
      expect(daemon.liveness()).toBe(true);
      expect((await fetch(`${daemon.url}/ready`)).status).toBe(503);
      const health = await fetch(`${daemon.url}/health`);
      expect(health.status).toBe(503);
      expect((await health.json()) as { ready: boolean }).toMatchObject({ ready: false });
      expect((await fetch(`${daemon.url}/live`)).status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  test("configDigest 排除 session/PID 并合并 deploy config：相同配置稳定、不同配置变化", async () => {
    const first = startDaemon(
      options({
        config: { target: "linux-x64", port: 0, session: "a", pid: 1 },
        runtime: { ...makeRuntime(), probes: createRuntimeProbeSource(probeRuntime("session-a")) },
      })
    );
    const second = startDaemon(
      options({
        config: { target: "linux-x64", port: 0, session: "b", pid: 2 },
        runtime: { ...makeRuntime(), probes: createRuntimeProbeSource(probeRuntime("session-b")) },
      })
    );
    const changed = startDaemon(
      options({
        config: { target: "linux-x64", port: 0, region: "eu" },
        runtime: { ...makeRuntime(), probes: createRuntimeProbeSource(probeRuntime("session-a")) },
      })
    );
    try {
      expect(first.configDigest()).toMatch(/^[0-9a-f]{64}$/);
      expect(second.configDigest()).toBe(first.configDigest());
      expect(changed.configDigest()).not.toBe(first.configDigest());
      expect((await (await fetch(`${first.url}/digest`)).json()) as { digest: string }).toEqual({
        digest: first.configDigest(),
      });
    } finally {
      await first.stop();
      await second.stop();
      await changed.stop();
    }
  });

  test("restart 前排空在途 RPC，runtime 只在排空后切换", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created = 0;
    const gated: RpcRuntime = {
      ...makeRuntime(),
      methods: { "t16.slow": async () => (await gate, { done: true }) },
    };
    const daemon = startDaemon(
      options({
        runtime: gated,
        runtimeFactory: () => {
          created += 1;
          return makeRuntime();
        },
        heartbeatMs: 10,
      })
    );
    try {
      const pending = daemon.rpc({ jsonrpc: "2.0", id: 1, method: "t16.slow" });
      const restarting = daemon.restart();
      expect(daemon.health().inFlight).toBe(1);
      expect(daemon.health().draining).toBe(true);
      await sleep(10);
      expect(created).toBe(0);
      release?.();
      expect((await pending).error).toBeUndefined();
      await restarting;
      expect(created).toBe(1);
      expect(daemon.health().draining).toBe(false);
      expect(daemon.health().inFlight).toBe(0);
    } finally {
      release?.();
      await daemon.stop();
    }
  }, 30_000);

  test("token 仅哈希存储，HTTP 校验全部走常数时间比较", async () => {
    const comparisons: Array<[number, number]> = [];
    const verifier = createTokenVerifier("t16-secret-token", {
      equal(left, right) {
        comparisons.push([left.byteLength, right.byteLength]);
        return timingSafeEqual(Buffer.from(left), Buffer.from(right));
      },
    });
    expect(verifier.hash).not.toContain("t16-secret-token");
    const daemon = startDaemon(options({ tokenVerifier: verifier }));
    try {
      const denied = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-token-value" },
        body: rpcBody(1),
      });
      expect(denied.status).toBe(401);
      const granted = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t16-secret-token" },
        body: rpcBody(2),
      });
      expect(granted.status).toBe(200);
      expect(comparisons.length).toBeGreaterThanOrEqual(2);
      expect(comparisons.every(([left, right]) => left === 32 && right === 32)).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  test("明文非 loopback 在监听之前拒绝，loopback 明文需显式开启", () => {
    expect(() => startDaemon(options({ host: "198.51.100.7" }))).toThrow("TLS_REQUIRED_FOR_NON_LOOPBACK");
    expect(() => startDaemon(options({ host: "0.0.0.0", allowPlainLoopback: true }))).toThrow(
      "TLS_REQUIRED_FOR_NON_LOOPBACK"
    );
  });

  test("mTLS 正向可用：带客户端证书可访问 /health，无证书握手被拒", async () => {
    const fixture = new URL("./__fixtures__/tls/", import.meta.url);
    const read = (name: string): string => readFileSync(new URL(name, fixture), "utf8");
    const ca = read("ca.cert.pem");
    const daemon = startDaemon(
      options({
        tls: {
          cert: read("server.cert.pem"),
          key: read("server.key.pem"),
          ca,
          requestCert: true,
          rejectUnauthorized: true,
        },
      })
    );
    try {
      expect(daemon.url).toMatch(/^https:\/\//);
      const withCert = await tlsGet(daemon.port, ca, {
        cert: read("client.cert.pem"),
        key: read("client.key.pem"),
      });
      expect(withCert.error).toBeUndefined();
      expect(withCert.body).toContain("HTTP/1.1 200");
      expect(JSON.parse(withCert.body.split("\r\n\r\n")[1] ?? "{}")).toMatchObject({ ready: true, live: true });

      const withoutCert = await tlsGet(daemon.port, ca, {});
      expect(withoutCert.error).toBeDefined();
      expect(withoutCert.body).not.toContain("HTTP/1.1 200");
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  function tlsGet(
    port: number,
    ca: string,
    identity: { readonly cert?: string; readonly key?: string }
  ): Promise<{ readonly body: string; readonly error?: string }> {
    return new Promise((resolve) => {
      const socket = tlsConnect(
        {
          host: "127.0.0.1",
          port,
          ca,
          servername: "localhost",
          rejectUnauthorized: true,
          ...identity,
        },
        () => {
          socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        }
      );
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("end", () => resolve({ body: buffer }));
      socket.on("error", (error) => resolve({ body: buffer, error: error.message }));
    });
  }
});
