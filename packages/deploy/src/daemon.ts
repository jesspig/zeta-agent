import { createRollout, type RolloutController } from "@zeta-agent/framework";
import {
  createControlFence,
  createLeaseRenewer,
  type ControlFence,
  type ControlLease,
  type LeaseRenewer,
} from "./control-lease";
import { computeDaemonConfigDigest } from "./config-digest";
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
import { createTokenVerifier, createTokenVerifierFromHash, type TokenVerifier } from "./token";
import {
  assertTransportAllowed,
  resolveBunTls,
  transportScheme,
  type DaemonTlsConfig,
} from "./transport";
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
  /** 明文 token 只在装配处短暂出现；daemon 仅保存 SHA-256 摘要。 */
  readonly token?: string;
  /** 已经哈希过的 token，供 handover/restart 在不传递明文的情况下复用。 */
  readonly tokenHash?: string;
  /** 可注入的 token 校验器，用于直接断言常数时间比较路径。 */
  readonly tokenVerifier?: TokenVerifier;
  readonly config: DeployConfig;
  readonly runtime: RpcRuntime;
  readonly runtimeFactory?: () => RpcRuntime;
  readonly port?: number;
  readonly ipcPort?: number;
  readonly host?: string;
  /** 非 loopback 必填 TLS/mTLS；loopback 明文必须显式 allowPlainLoopback。 */
  readonly tls?: DaemonTlsConfig;
  readonly allowPlainLoopback?: boolean;
  readonly heartbeatMs?: number;
  readonly autoRestart?: boolean;
  readonly owner?: string;
  readonly fence?: ControlFence;
  readonly hub?: EventHub;
  readonly rollout?: RolloutController;
  readonly writer?: StdoutWriter;
  readonly echoResponses?: boolean;
  /** 可注入时钟：租约 TTL 与续租判定都用这个时钟，便于假时钟测试。 */
  readonly now?: () => number;
  readonly leaseTtlMs?: number;
  /** 0 表示禁用自动续租（仅用于过期反例）；默认 TTL 的 1/3。 */
  readonly leaseRenewMs?: number;
  /** 过期后是否自动重新获取租约；关闭后保持 EXPIRED 终态，便于故障观察。 */
  readonly leaseAutoRecover?: boolean;
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

function bearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1];
}

/**
 * 真实 HTTP + IPC 控制面 daemon：token 哈希与常数时间校验、租约定时续期、
 * 聚合 readiness（未 ready 返回 503）、故障自动重启、非 loopback 强制 mTLS。
 * 所有 RPC 都经 T-10/T-14 的同一 dispatcher。
 */
export function startDaemon(options: DaemonOptions): DaemonHandle {
  if (
    options.tokenVerifier === undefined &&
    typeof options.token !== "string" &&
    typeof options.tokenHash !== "string"
  ) {
    throw new Error("DAEMON_TOKEN_REQUIRED");
  }
  const verifier =
    options.tokenVerifier ??
    (options.tokenHash !== undefined ? createTokenVerifierFromHash(options.tokenHash) : createTokenVerifier(options.token!));

  const host = options.host ?? "127.0.0.1";
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const owner = options.owner ?? "daemon";
  const now = options.now ?? (() => Date.now());
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;

  // 传输门禁在任何监听之前执行：不满足时根本没有明文 socket 可连接。
  assertTransportAllowed({ host, tls: options.tls, allowPlainLoopback: options.allowPlainLoopback });
  const bunTls = resolveBunTls(options.tls);

  const fence = options.fence ?? createControlFence({ now, ttlMs: leaseTtlMs });
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
  let draining = false;
  let restarting: Promise<void> | undefined;
  let restartCount = 0;
  let handoverCount = 0;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  const clients = new Map<IpcSocket, IpcClient>();

  function installRenewer(lease: ControlLease): LeaseRenewer {
    return createLeaseRenewer({
      lease,
      ttlMs: leaseTtlMs,
      now,
      reacquire: options.leaseAutoRecover === false ? undefined : () => fence.tryAcquire(owner) ?? undefined,
      onPhaseChange(phase, reason) {
        if (phase === "expired") {
          hub.emit({ type: "daemon.lease.expired", reason, generation: ownedGeneration });
          return;
        }
        if (phase === "active" && reason === "RECOVERED") {
          const recovered = renewer?.lease;
          if (recovered !== undefined) {
            activeLease = recovered;
            ownedGeneration = recovered.generation;
            for (const [socket, client] of clients) {
              if (client.generation !== ownedGeneration) {
                writeFrame(socket, { kind: "restart", generation: ownedGeneration });
                clients.delete(socket);
              }
            }
            hub.emit({ type: "daemon.lease.recovered", generation: ownedGeneration });
          }
        }
      },
    });
  }

  let renewer: LeaseRenewer | undefined = activeLease === undefined ? undefined : installRenewer(activeLease);

  function leaseActive(): boolean {
    return renewer !== undefined && renewer.active && activeLease !== undefined && activeLease.active;
  }

  function authorized(headerValue: string | null, tokenHeader: string | null): boolean {
    // 两个候选都走哈希 + 常数时间比较，不因短路泄露信息。
    const byBearer = verifier.verify(bearerToken(headerValue));
    const byHeader = verifier.verify(tokenHeader);
    return byBearer || byHeader;
  }

  function liveness(): boolean {
    return !closed && !faulted && deploy.liveness() && runtime.probes.liveness();
  }

  /** readiness 聚合关键依赖 + 控制租约 active；任一失败立即 false。 */
  function readiness(): boolean {
    return liveness() && deploy.readiness() && runtime.probes.readiness() && leaseActive();
  }

  function configDigest(): string {
    return computeDaemonConfigDigest(options.config, runtime.probes.configDigest());
  }

  function beginRpc(): void {
    inFlight += 1;
  }

  function endRpc(): void {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      for (const resolve of [...drainWaiters]) resolve();
      drainWaiters.clear();
    }
  }

  function drainInFlight(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.add(resolve);
    });
  }

  async function handleRpc(request: RpcRequest): Promise<RpcResponse> {
    const id = typeof request?.id === "number" ? request.id : 0;
    if (draining || !leaseActive()) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR_CODES.NOT_LEADER, message: draining ? "DRAINING" : "NOT_LEADER" },
      };
    }
    beginRpc();
    const work = rollout.acquireWork(owner);
    try {
      const response = await dispatcher.handle(request);
      if (options.echoResponses === true && options.writer !== undefined) {
        options.writer.write(`${encodeRpcResponse(response)}\n`);
      }
      return response;
    } finally {
      work.release();
      endRpc();
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
      if (!verifier.verify(frame.token)) {
        writeFrame(socket, { kind: "error", error: "UNAUTHORIZED" });
        return;
      }
      client.lastSeen = Date.now();
      writeFrame(socket, { kind: "hello.ack", generation: ownedGeneration, owner });
      return;
    }
    if (!verifier.verify(frame.token)) {
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

  const serveOptions = {
    hostname: host,
    port: options.port ?? 0,
    ...(bunTls !== undefined ? { tls: bunTls } : {}),
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        if (url.pathname === "/health") {
          const ready = readiness();
          return json(
            {
              ready,
              live: liveness(),
              digest: configDigest(),
              generation: fence.generation,
              clients: clients.size,
              owner,
              lease: leaseActive(),
              scheme: transportScheme(options.tls),
            },
            ready ? 200 : 503
          );
        }
        if (url.pathname === "/ready") {
          const ready = readiness();
          return json({ ready }, ready ? 200 : 503);
        }
        if (url.pathname === "/live") {
          const live = liveness();
          return json({ live }, live ? 200 : 503);
        }
        if (url.pathname === "/digest") return json({ digest: configDigest() });
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
  } as unknown as Parameters<typeof Bun.serve>[0];
  const httpServer = Bun.serve(serveOptions);

  const ipcServer = Bun.listen({
    hostname: host,
    port: options.ipcPort ?? 0,
    ...(bunTls !== undefined ? { tls: bunTls } : {}),
    socket: {
      data(socket: IpcSocket, data: Uint8Array) {
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
      close(socket: IpcSocket) {
        clients.delete(socket as unknown as IpcSocket);
      },
      error(socket: IpcSocket) {
        clients.delete(socket as unknown as IpcSocket);
      },
    },
  } as unknown as Parameters<typeof Bun.listen>[0]);

  const timer = setInterval(() => {
    if (closed) return;
    const stamped = Date.now();
    for (const [socket, client] of clients) {
      if (stamped - client.lastSeen > heartbeatMs * 4) {
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

  // 独立租约续期定时器：跨多个 TTL 周期持续续租；失败立即进入 EXPIRED 并停止新 RPC。
  const leaseRenewMs = options.leaseRenewMs ?? Math.max(1, Math.floor(leaseTtlMs / 3));
  const leaseTimer =
    leaseRenewMs > 0
      ? setInterval(() => {
          // 过期后仍要 tick：由状态机判定失败/恢复，不能因 active=false 跳过而卡在 ACTIVE。
          if (closed || renewer === undefined || renewer.phase === "released") return;
          renewer.tick(now());
        }, leaseRenewMs)
      : undefined;
  leaseTimer?.unref?.();

  async function restart(): Promise<void> {
    if (closed) throw new Error("DAEMON_CLOSED");
    if (restarting !== undefined) return restarting;
    restarting = (async () => {
      // 排空在途 RPC 之后才切换 runtime / 租约，绝不在调用途中硬切。
      draining = true;
      try {
        await drainInFlight();
        if (closed) return;
        if (options.runtimeFactory === undefined) throw new Error("RUNTIME_FACTORY_REQUIRED");
        runtime = options.runtimeFactory();
        dispatcher = createRpcDispatcher(runtime);
        const next = fence.replace(owner);
        activeLease = next;
        if (renewer === undefined) renewer = installRenewer(next);
        else renewer.reset(next);
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
      } finally {
        draining = false;
        restarting = undefined;
      }
    })();
    return restarting;
  }

  async function replace(next: Partial<DaemonOptions> = {}): Promise<DaemonHandle> {
    if (closed) throw new Error("DAEMON_CLOSED");
    // 排空旧代次的在途 RPC，再让后继强制接管控制租约；期间不会有双主。
    await drainInFlight();
    await rollout.beginCanary([owner], fence.generation + 1);
    await rollout.rollback();
    await rollout.drain(owner);
    const successor = startDaemon({
      token: next.token,
      tokenHash: next.token === undefined ? verifier.hash : undefined,
      tokenVerifier: next.tokenVerifier,
      config: next.config ?? options.config,
      runtime: next.runtime ?? options.runtimeFactory?.() ?? runtime,
      runtimeFactory: next.runtimeFactory ?? options.runtimeFactory,
      port: next.port ?? 0,
      ipcPort: next.ipcPort ?? 0,
      host: next.host ?? host,
      tls: next.tls ?? options.tls,
      allowPlainLoopback: next.allowPlainLoopback ?? options.allowPlainLoopback,
      heartbeatMs: next.heartbeatMs ?? heartbeatMs,
      autoRestart: next.autoRestart ?? options.autoRestart,
      now: next.now ?? now,
      leaseTtlMs: next.leaseTtlMs ?? leaseTtlMs,
      leaseRenewMs: next.leaseRenewMs ?? leaseRenewMs,
      leaseAutoRecover: next.leaseAutoRecover ?? options.leaseAutoRecover,
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
    if (leaseTimer !== undefined) clearInterval(leaseTimer);
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
    renewer?.release();
    activeLease = undefined;
    deploy.stop();
    for (const resolve of [...drainWaiters]) resolve();
    drainWaiters.clear();
    await rollout.close();
  }

  const handle: DaemonHandle = {
    get port() {
      return httpServer.port ?? 0;
    },
    get ipcPort() {
      return (ipcServer as unknown as { port?: number }).port ?? 0;
    },
    get url() {
      return `${transportScheme(options.tls)}://${host}:${httpServer.port ?? 0}`;
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
      return leaseActive() ? activeLease : undefined;
    },
    get restartCount() {
      return restartCount;
    },
    get handoverCount() {
      return handoverCount;
    },
    readiness,
    liveness,
    configDigest,
    health() {
      return {
        ready: readiness(),
        live: liveness(),
        digest: configDigest(),
        generation: fence.generation,
        clients: clients.size,
        owner,
        restarts: restartCount,
        handovers: handoverCount,
        lease: leaseActive(),
        leasePhase: renewer?.phase ?? "none",
        renewals: renewer?.renewals ?? 0,
        failures: renewer?.failures ?? 0,
        inFlight,
        draining,
        scheme: transportScheme(options.tls),
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
