import { createRollout, type RolloutController } from "@zeta-agent/framework";
import { createControlFence, type ControlFence, type ControlLease } from "./control-lease";
import { start, type DeployConfig, type DeployHandle } from "./deployment";
import {
  createRpcDispatcher,
  encodeRpcResponse,
  RPC_ERROR_CODES,
  type RpcDispatcher,
  type RpcRequest,
  type RpcResponse,
  type RpcRuntime,
} from "./rpc";
import type { StdoutWriter } from "./stdout";

export interface DaemonEvent {
  readonly type: string;
  readonly seq: number;
  readonly generation: number;
  readonly at: number;
  readonly [key: string]: unknown;
}

export interface EventHub {
  readonly events: readonly DaemonEvent[];
  emit(event: { readonly type: string; readonly [key: string]: unknown }): DaemonEvent;
  subscribe(listener: (event: DaemonEvent) => void): () => void;
}

/** 跨 daemon 代次共享的事件日志：handover 前后订阅者不丢失任何事件。 */
export function createEventHub(): EventHub {
  const events: DaemonEvent[] = [];
  const listeners = new Set<(event: DaemonEvent) => void>();
  let seq = 0;
  return {
    get events() {
      return [...events];
    },
    emit(input) {
      const event: DaemonEvent = {
        ...input,
        type: input.type,
        seq: (seq += 1),
        generation: typeof input.generation === "number" ? input.generation : 0,
        at: Date.now(),
      };
      events.push(event);
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface DaemonOptions {
  readonly token: string;
  readonly config: DeployConfig;
  readonly runtime: RpcRuntime;
  readonly runtimeFactory?: () => RpcRuntime;
  readonly port?: number;
  readonly ipcPort?: number;
  readonly host?: string;
  readonly heartbeatMs?: number;
  readonly autoRestart?: boolean;
  readonly owner?: string;
  readonly fence?: ControlFence;
  readonly hub?: EventHub;
  readonly rollout?: RolloutController;
  readonly writer?: StdoutWriter;
  readonly echoResponses?: boolean;
  /** 内部：handover 后继强制接管，不经过 tryAcquire 的双启动保护。 */
  readonly force?: boolean;
}

export interface DaemonHandle {
  readonly port: number;
  readonly ipcPort: number;
  readonly url: string;
  readonly owner: string;
  readonly generation: number;
  readonly clients: number;
  readonly fence: ControlFence;
  readonly lease: ControlLease | undefined;
  readonly restartCount: number;
  readonly handoverCount: number;
  readiness(): boolean;
  liveness(): boolean;
  configDigest(): string;
  health(): Record<string, unknown>;
  rpc(request: RpcRequest): Promise<RpcResponse>;
  emit(event: { readonly type: string; readonly [key: string]: unknown }): DaemonEvent;
  fault(): void;
  restart(): Promise<void>;
  replace(next?: Partial<DaemonOptions>): Promise<DaemonHandle>;
  stop(): Promise<void>;
}

interface IpcSocket {
  write(data: string): number;
  end(): void;
}

interface IpcClient {
  readonly generation: number;
  lastSeen: number;
  buffer: string;
  readonly decoder: TextDecoder;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 真实 HTTP + IPC 控制面 daemon：token 认证、心跳、多客户端、故障自动重启、
 * 控制租约与替换代次栅栏。所有 RPC 都经 T-10/T-14 的同一 dispatcher。
 */
export function startDaemon(options: DaemonOptions): DaemonHandle {
  if (typeof options.token !== "string" || options.token.length === 0) throw new Error("DAEMON_TOKEN_REQUIRED");
  const host = options.host ?? "127.0.0.1";
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const owner = options.owner ?? "daemon";
  const fence = options.fence ?? createControlFence();
  const hub = options.hub ?? createEventHub();
  const deploy: DeployHandle = start("daemon", options.config);
  deploy.setReadiness(true);

  let runtime = options.runtime;
  let dispatcher: RpcDispatcher = createRpcDispatcher(runtime);
  let activeLease: ControlLease | undefined = options.force === true ? fence.replace(owner) : fence.tryAcquire(owner);
  let ownedGeneration = activeLease?.generation ?? fence.generation;
  let rollout: RolloutController =
    options.rollout ?? createRollout({ hosts: [owner], initialGeneration: fence.generation });
  let faulted = false;
  let closed = false;
  let restartCount = 0;
  let handoverCount = 0;
  const clients = new Map<IpcSocket, IpcClient>();

  function authorized(headerValue: string | null, tokenHeader: string | null): boolean {
    return headerValue === `Bearer ${options.token}` || tokenHeader === options.token;
  }

  function liveness(): boolean {
    return !closed && !faulted && deploy.liveness() && runtime.probes.liveness();
  }

  function readiness(): boolean {
    return liveness() && deploy.readiness() && runtime.probes.readiness() && activeLease !== undefined;
  }

  async function handleRpc(request: RpcRequest): Promise<RpcResponse> {
    const id = typeof request?.id === "number" ? request.id : 0;
    if (activeLease === undefined || !activeLease.active) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR_CODES.NOT_LEADER, message: "NOT_LEADER" },
      };
    }
    const work = rollout.acquireWork(owner);
    try {
      const response = await dispatcher.handle(request);
      if (options.echoResponses === true && options.writer !== undefined) {
        options.writer.write(`${encodeRpcResponse(response)}\n`);
      }
      return response;
    } finally {
      work.release();
    }
  }

  function writeFrame(socket: IpcSocket, frame: Record<string, unknown>): void {
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // 对端可能已消失；心跳循环负责清理。
    }
  }

  function handleIpcFrame(socket: IpcSocket, client: IpcClient, raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.kind === "hello") {
      if (frame.token !== options.token) {
        writeFrame(socket, { kind: "error", error: "UNAUTHORIZED" });
        return;
      }
      client.lastSeen = Date.now();
      writeFrame(socket, { kind: "hello.ack", generation: ownedGeneration, owner });
      return;
    }
    if (frame.token !== options.token) {
      writeFrame(socket, { kind: "error", error: "UNAUTHORIZED" });
      return;
    }
    if (frame.generation !== ownedGeneration) {
      writeFrame(socket, {
        kind: "error",
        error: "STALE_GENERATION",
        generation: ownedGeneration,
        received: frame.generation,
      });
      return;
    }
    client.lastSeen = Date.now();
    if (frame.kind === "heartbeat") {
      writeFrame(socket, { kind: "heartbeat.ack", generation: ownedGeneration, seq: frame.seq, at: client.lastSeen });
      return;
    }
    if (frame.kind === "rpc") {
      void handleRpc(frame.request as RpcRequest).then((response) => {
        writeFrame(socket, { kind: "rpc.result", id: frame.id, response });
      });
    }
  }

  const httpServer = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        if (url.pathname === "/health") {
          return json({
            ready: readiness(),
            live: liveness(),
            digest: runtime.probes.configDigest(),
            generation: fence.generation,
            clients: clients.size,
            owner,
          });
        }
        if (url.pathname === "/ready") return json({ ready: readiness() });
        if (url.pathname === "/live") return json({ live: liveness() });
        if (url.pathname === "/digest") return json({ digest: runtime.probes.configDigest() });
        return new Response("NOT_FOUND", { status: 404 });
      }
      if (url.pathname !== "/rpc" || request.method !== "POST") {
        return new Response("NOT_FOUND", { status: 404 });
      }
      if (!authorized(request.headers.get("authorization"), request.headers.get("x-zeta-token"))) {
        return json({ error: "UNAUTHORIZED" }, 401);
      }
      const generationHeader = request.headers.get("x-zeta-generation");
      if (generationHeader !== null && Number(generationHeader) !== ownedGeneration) {
        return json(
          {
            jsonrpc: "2.0",
            id: 0,
            error: { code: RPC_ERROR_CODES.STALE_GENERATION, message: "STALE_GENERATION" },
          },
          409
        );
      }
      let payload: RpcRequest;
      try {
        payload = JSON.parse(await request.text()) as RpcRequest;
      } catch {
        return json({ jsonrpc: "2.0", id: 0, error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: "INVALID_JSON" } });
      }
      return json(await handleRpc(payload));
    },
  });

  const ipcServer = Bun.listen({
    hostname: host,
    port: options.ipcPort ?? 0,
    socket: {
      data(socket, data) {
        const raw = socket as unknown as IpcSocket;
        let client = clients.get(raw);
        if (client === undefined) {
          client = { generation: ownedGeneration, lastSeen: Date.now(), buffer: "", decoder: new TextDecoder() };
          clients.set(raw, client);
        }
        client.buffer += client.decoder.decode(data, { stream: true });
        let index = client.buffer.indexOf("\n");
        while (index >= 0) {
          const line = client.buffer.slice(0, index);
          client.buffer = client.buffer.slice(index + 1);
          index = client.buffer.indexOf("\n");
          if (line.length === 0) continue;
          handleIpcFrame(raw, client, line);
        }
      },
      close(socket) {
        clients.delete(socket as unknown as IpcSocket);
      },
      error(socket) {
        clients.delete(socket as unknown as IpcSocket);
      },
    },
  });

  const timer = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    for (const [socket, client] of clients) {
      if (now - client.lastSeen > heartbeatMs * 4) {
        clients.delete(socket);
        try {
          socket.end();
        } catch {
          // 对端已消失。
        }
      }
    }
    if (faulted && options.autoRestart === true && options.runtimeFactory !== undefined) {
      void restart();
    }
  }, heartbeatMs);
  timer.unref?.();

  async function restart(): Promise<void> {
    if (closed) throw new Error("DAEMON_CLOSED");
    if (options.runtimeFactory === undefined) throw new Error("RUNTIME_FACTORY_REQUIRED");
    runtime = options.runtimeFactory();
    dispatcher = createRpcDispatcher(runtime);
    const next = fence.replace(owner);
    activeLease = next;
    ownedGeneration = next.generation;
    faulted = false;
    restartCount += 1;
    await rollout.beginCanary([owner], next.generation);
    await rollout.promote();
    for (const [socket, client] of clients) {
      if (client.generation !== next.generation) {
        writeFrame(socket, { kind: "restart", generation: next.generation });
        clients.delete(socket);
      }
    }
    hub.emit({ type: "daemon.restart", generation: next.generation });
  }

  async function replace(next: Partial<DaemonOptions> = {}): Promise<DaemonHandle> {
    if (closed) throw new Error("DAEMON_CLOSED");
    // 排空旧代次的在途 RPC，再让后继强制接管控制租约；期间不会有双主。
    await rollout.beginCanary([owner], fence.generation + 1);
    await rollout.rollback();
    await rollout.drain(owner);
    const successor = startDaemon({
      token: next.token ?? options.token,
      config: next.config ?? options.config,
      runtime: next.runtime ?? options.runtimeFactory?.() ?? runtime,
      runtimeFactory: next.runtimeFactory ?? options.runtimeFactory,
      port: next.port ?? 0,
      ipcPort: next.ipcPort ?? 0,
      host: next.host ?? host,
      heartbeatMs: next.heartbeatMs ?? heartbeatMs,
      autoRestart: next.autoRestart ?? options.autoRestart,
      owner: next.owner ?? `${owner}-successor`,
      fence,
      hub,
      writer: next.writer ?? options.writer,
      echoResponses: next.echoResponses ?? options.echoResponses,
      force: true,
    });
    handoverCount += 1;
    for (const [socket] of clients) {
      writeFrame(socket, { kind: "handover", url: successor.url, generation: successor.generation });
    }
    await stop();
    return successor;
  }

  async function stop(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    httpServer.stop(true);
    ipcServer.stop(true);
    for (const [socket] of clients) {
      try {
        socket.end();
      } catch {
        // 已断开。
      }
    }
    clients.clear();
    if (activeLease !== undefined) fence.release(owner, activeLease.generation);
    activeLease = undefined;
    deploy.stop();
    await rollout.close();
  }

  const handle: DaemonHandle = {
    get port() {
      return httpServer.port ?? 0;
    },
    get ipcPort() {
      return ipcServer.port ?? 0;
    },
    get url() {
      return `http://${host}:${httpServer.port}`;
    },
    owner,
    get generation() {
      return ownedGeneration;
    },
    get clients() {
      return clients.size;
    },
    fence,
    get lease() {
      return activeLease;
    },
    get restartCount() {
      return restartCount;
    },
    get handoverCount() {
      return handoverCount;
    },
    readiness,
    liveness,
    configDigest: () => runtime.probes.configDigest(),
    health() {
      return {
        ready: readiness(),
        live: liveness(),
        digest: runtime.probes.configDigest(),
        generation: fence.generation,
        clients: clients.size,
        owner,
        restarts: restartCount,
        handovers: handoverCount,
      };
    },
    rpc: (request) => handleRpc(request),
    emit(input) {
      return hub.emit({ ...input, generation: fence.generation });
    },
    fault() {
      faulted = true;
    },
    restart,
    replace,
    stop,
  };

  // 事件广播：订阅 hub 后所有客户端共享同一代次事件流，handover 不重建订阅。
  hub.subscribe((event) => {
    for (const [socket, client] of clients) {
      if (client.generation === event.generation || event.generation === 0) {
        writeFrame(socket, { kind: "event", event });
      }
    }
  });

  return handle;
}
