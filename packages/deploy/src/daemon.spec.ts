import { describe, expect, test } from "bun:test";
import { createControlFence } from "./control-lease";
import { createEventHub, startDaemon, type DaemonEvent, type DaemonOptions } from "./daemon";
import { createMemorySessionControl, type RpcRuntime } from "./rpc";
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
    expect(health).toMatchObject({ ready: true, live: true, digest: "digest-1" });

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
