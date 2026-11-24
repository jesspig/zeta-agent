import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { Disposer } from "../types";

export interface Link {
  readonly closed: boolean;
  /** 关闭后 send 为 no-op。 */
  send(message: unknown): void;
  /** 单 listener：重复注册抛错。 */
  onMessage(listener: (message: unknown) => void): Disposer;
  onClose(listener: () => void): Disposer;
  close(): void;
}

/** 线上帧：id 关联回执，generation 隔离代次（旧进程迟到消息直接丢弃）。 */
export interface WireFrame {
  readonly id: number;
  readonly seq: number;
  readonly generation: number;
  readonly kind: "data" | "receipt" | "close";
  readonly payload: unknown;
}

export interface Codec {
  encode(frame: WireFrame): string;
  decode(raw: string): WireFrame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createJsonCodec(): Codec {
  return {
    encode(frame) {
      return JSON.stringify(frame);
    },
    decode(raw) {
      const value: unknown = JSON.parse(raw);
      if (
        !isRecord(value) ||
        typeof value.id !== "number" ||
        typeof value.seq !== "number" ||
        typeof value.generation !== "number" ||
        (value.kind !== "data" && value.kind !== "receipt" && value.kind !== "close")
      ) {
        throw new Error("INVALID_WIRE_FRAME");
      }
      return value as unknown as WireFrame;
    },
  };
}

export class BackpressureError extends Error {
  readonly kind = "BACKPRESSURE" as const;
  constructor(message = "link 出站队列已满") {
    super(message);
    this.name = "BackpressureError";
  }
}

export class PeerClosedError extends Error {
  readonly kind = "PEER_CLOSED" as const;
  constructor(message = "对端已关闭") {
    super(message);
    this.name = "PeerClosedError";
  }
}

export interface Receipt {
  readonly id: number;
  readonly ok: boolean;
  readonly generation: number;
}

export interface LinkOptions {
  readonly codec?: Codec;
  readonly generation?: number;
  readonly maxQueue?: number;
  readonly ackTimeoutMs?: number;
}

export interface RichLink extends Link {
  readonly generation: number;
  readonly queued: number;
  readonly pendingReceipts: number;
  /** 等待对端确认；对端关闭或超时则拒绝。 */
  sendWithReceipt(message: unknown, timeoutMs?: number): Promise<Receipt>;
  onDrain(listener: () => void): Disposer;
  /** 测试/重连重放入口：直接投递一帧原始线上数据。 */
  ingest(raw: string): void;
  /** 暂停出站泵，用于构造确定性的背压窗口。 */
  pause(): void;
  resume(): void;
}

interface Transport {
  send(raw: string): void;
  attach(onFrame: (raw: string) => void, onClose: () => void): void;
  close(): void;
}

interface PendingReceipt {
  resolve(receipt: Receipt): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

function createLink(transport: Transport, options: LinkOptions = {}): RichLink {
  const codec = options.codec ?? createJsonCodec();
  const generation = options.generation ?? 0;
  const maxQueue = options.maxQueue ?? 8;
  const ackTimeoutMs = options.ackTimeoutMs ?? 1000;
  const queue: WireFrame[] = [];
  const pending = new Map<number, PendingReceipt>();
  const closeListeners = new Set<() => void>();
  const drainListeners = new Set<() => void>();
  let listener: ((message: unknown) => void) | undefined;
  let closed = false;
  let paused = false;
  let draining = false;
  let sendSeq = 0;
  let frameId = 0;

  function rejectPending(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handlePeerClose(): void {
    if (closed) return;
    closed = true;
    queue.length = 0;
    listener = undefined;
    rejectPending(new PeerClosedError());
    for (const next of [...closeListeners]) next();
    closeListeners.clear();
  }

  function deliver(frame: WireFrame): void {
    if (frame.kind === "close") {
      handlePeerClose();
      return;
    }
    if (frame.kind === "receipt") {
      const entry = pending.get(frame.id);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      entry.resolve({ id: frame.id, ok: frame.payload !== false, generation: frame.generation });
      return;
    }
    if (frame.kind !== "data" || frame.generation !== generation) return;
    try {
      listener?.(frame.payload);
    } finally {
      // 回执绕过背压队列，避免两侧同时满时互相死锁。
      transport.send(codec.encode({
        id: frame.id,
        seq: frame.seq,
        generation,
        kind: "receipt",
        payload: true,
      }));
    }
  }

  function onRaw(raw: string): void {
    try {
      deliver(codec.decode(raw));
    } catch {
      // 线上噪声不影响连接：只有合法帧才进入状态机。
    }
  }

  transport.attach(onRaw, handlePeerClose);

  function drain(): void {
    if (draining || paused || closed) return;
    draining = true;
    queueMicrotask(() => {
      try {
        while (!closed && !paused && queue.length > 0) {
          const frame = queue.shift() as WireFrame;
          transport.send(codec.encode(frame));
        }
      } finally {
        draining = false;
        if (!closed && !paused && queue.length === 0) {
          for (const next of [...drainListeners]) next();
        }
      }
    });
  }

  function enqueue(frame: WireFrame): void {
    if (closed) return;
    if (queue.length >= maxQueue) throw new BackpressureError();
    queue.push(frame);
    drain();
  }

  const link: RichLink = {
    get closed(): boolean {
      return closed;
    },
    get generation(): number {
      return generation;
    },
    get queued(): number {
      return queue.length;
    },
    get pendingReceipts(): number {
      return pending.size;
    },
    send(message: unknown): void {
      if (closed) return;
      enqueue({ id: ++frameId, seq: ++sendSeq, generation, kind: "data", payload: message });
    },
    sendWithReceipt(message: unknown, timeoutMs = ackTimeoutMs): Promise<Receipt> {
      if (closed) return Promise.reject(new PeerClosedError());
      const id = ++frameId;
      const frame: WireFrame = { id, seq: ++sendSeq, generation, kind: "data", payload: message };
      return new Promise<Receipt>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("RECEIPT_TIMEOUT"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          enqueue(frame);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    onMessage(next: (message: unknown) => void): Disposer {
      if (closed) throw new Error("LINK_CLOSED");
      if (listener !== undefined) throw new Error("SINGLE_LISTENER");
      listener = next;
      return (): void => {
        if (listener === next) listener = undefined;
      };
    },
    onClose(next: () => void): Disposer {
      if (closed) {
        next();
        return (): void => {};
      }
      closeListeners.add(next);
      return (): void => {
        closeListeners.delete(next);
      };
    },
    onDrain(next: () => void): Disposer {
      drainListeners.add(next);
      return (): void => {
        drainListeners.delete(next);
      };
    },
    ingest(raw: string): void {
      onRaw(raw);
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      drain();
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        transport.send(codec.encode({
          id: ++frameId,
          seq: ++sendSeq,
          generation,
          kind: "close",
          payload: null,
        }));
      } catch {
        // 对端可能已经消失，关闭帧尽力而为。
      }
      queue.length = 0;
      listener = undefined;
      rejectPending(new PeerClosedError());
      for (const next of [...closeListeners]) next();
      closeListeners.clear();
      transport.close();
    },
  };
  return link;
}

function memoryTransports(): readonly [Transport, Transport] {
  let toA: ((raw: string) => void) | undefined;
  let toB: ((raw: string) => void) | undefined;
  let closeA: (() => void) | undefined;
  let closeB: (() => void) | undefined;
  const a: Transport = {
    send(raw) {
      toB?.(raw);
    },
    attach(onFrame, onClose) {
      toA = onFrame;
      closeA = onClose;
    },
    close() {
      closeB?.();
    },
  };
  const b: Transport = {
    send(raw) {
      toA?.(raw);
    },
    attach(onFrame, onClose) {
      toB = onFrame;
      closeB = onClose;
    },
    close() {
      closeA?.();
    },
  };
  return [a, b];
}

/** 进程内成对 Link（共享 codec/回执/背压语义）。 */
export function memoryLinkPair(options: LinkOptions = {}): readonly [RichLink, RichLink] {
  const [a, b] = memoryTransports();
  return [createLink(a, options), createLink(b, options)];
}

function portTransport(port: MessagePort): Transport {
  return {
    send(raw) {
      port.postMessage(raw);
    },
    attach(onFrame, onClose) {
      port.on("message", (data: unknown) => onFrame(String(data)));
      port.on("close", onClose);
    },
    close() {
      port.close();
    },
  };
}

/** worker_threads MessageChannel 成对 Link：真实结构化克隆边界。 */
export function ipcLinkPair(options: LinkOptions = {}): readonly [RichLink, RichLink] {
  const { port1, port2 } = new MessageChannel();
  port1.unref?.();
  port2.unref?.();
  return [createLink(portTransport(port1), options), createLink(portTransport(port2), options)];
}

export interface WsLinkOptions extends LinkOptions {
  readonly port?: number;
}

/** 真实 loopback WebSocket 成对 Link：server 端与 client 端。 */
export async function wsLinkPair(options: WsLinkOptions = {}): Promise<readonly [RichLink, RichLink]> {
  let serverSocket: any;
  let serverFrame: ((raw: string) => void) | undefined;
  let serverClose: (() => void) | undefined;
  let server: any;

  const serverTransport: Transport = {
    send(raw) {
      serverSocket?.send(raw);
    },
    attach(onFrame, onClose) {
      serverFrame = onFrame;
      serverClose = () => {
        onClose();
        server?.stop(true);
      };
    },
    close() {
      server?.stop(true);
    },
  };

  server = Bun.serve({
    port: options.port ?? 0,
    fetch(req, instance) {
      if (instance.upgrade(req)) return undefined;
      return new Response("UPGRADE_FAILED", { status: 400 });
    },
    websocket: {
      open(socket) {
        serverSocket = socket;
      },
      message(_socket, raw) {
        serverFrame?.(String(raw));
      },
      close() {
        serverClose?.();
      },
    },
  });

  const url = `ws://127.0.0.1:${server.port}`;
  const clientSocket = new WebSocket(url);
  let clientFrame: ((raw: string) => void) | undefined;
  let clientClose: (() => void) | undefined;
  const clientTransport: Transport = {
    send(raw) {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(raw);
    },
    attach(onFrame, onClose) {
      clientFrame = onFrame;
      clientClose = onClose;
    },
    close() {
      clientSocket.close();
    },
  };
  clientSocket.onmessage = (event) => {
    clientFrame?.(String(event.data));
  };
  clientSocket.onclose = () => {
    clientClose?.();
  };
  await new Promise<void>((resolve, reject) => {
    clientSocket.onopen = () => resolve();
    clientSocket.onerror = () => reject(new Error("WS_OPEN_FAILED"));
  });
  for (let attempt = 0; attempt < 50 && serverSocket === undefined; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return [createLink(serverTransport, options), createLink(clientTransport, options)];
}
