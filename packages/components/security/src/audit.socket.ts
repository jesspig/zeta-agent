import {
  AUDIT_CLIENT_TOKEN_ENV,
  defaultHash,
  fingerprint,
  type AuditEntry,
  type AuditIntegrityResult,
  type AuditRecord,
  type AuditSink,
  type FinalizedState,
  type HashFn,
} from "./audit";

/** 端点只描述"连到哪里"，永不包含签名密钥。tcp:host:port（0=随机端口）或 unix:路径。 */
export type AuditEndpoint = string;

export interface SocketAuditSinkOptions {
  readonly endpoint: AuditEndpoint;
  /** 客户端认证令牌；只随请求发送，永不进入 endpoint 或产物。 */
  /** 显式传入或由 AUDIT_CLIENT_TOKEN_ENV 提供；两者都无则拒绝构造。 */
  readonly token?: string;
  /** 未确认请求的有界上限；超出即计为 drop，不阻塞工具路径。 */
  readonly queueLimit?: number;
  readonly hash?: HashFn;
}

export interface SocketFinalizeResult {
  readonly ok: boolean;
  readonly revision: number;
  readonly seq: number;
}

export interface SocketAuditSink extends AuditSink {
  readonly transport: "socket";
  readonly endpoint: AuditEndpoint;
  /** 连接建立后 resolve；连接失败则 reject。 */
  ready(): Promise<void>;
  /** daemon 已确认的最后一条 append 序号；未确认时为 -1。 */
  ackedSeq(): number;
  /** 追加并等待 daemon 的权威 ack（含 seq / hash）；认证或队列满时 reject。 */
  appendAck(record: AuditRecord): Promise<AuditEntry>;
  /** 等待此前排队的 append 已被 daemon 处理（barrier）。 */
  flush(): Promise<void>;
  /** 请求 daemon 封存 finalized 标记，密钥不离开 daemon。 */
  finalizeRemote(revision: number, finalized: FinalizedState): Promise<SocketFinalizeResult>;
  /** 请求 daemon 重新读取落盘链与标记做跨进程校验。 */
  verifyRemote(revision: number): Promise<AuditIntegrityResult>;
  close(): Promise<void>;
}

type WireRequest = { readonly kind: string; readonly id?: string } & Record<string, unknown>;
interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}
interface Writer {
  write(data: string): number;
  end(): void;
}

type Target = { readonly type: "unix"; readonly path: string } | { readonly type: "tcp"; readonly host: string; readonly port: number };

export function parseAuditEndpoint(endpoint: string): Target {
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("INVALID_AUDIT_ENDPOINT");
  if (endpoint.startsWith("unix:")) {
    const path = endpoint.slice("unix:".length);
    if (path.length === 0) throw new Error("INVALID_AUDIT_ENDPOINT");
    return { type: "unix", path };
  }
  const match = /^tcp:([^:]+):(\d+)$/.exec(endpoint);
  if (match === null) throw new Error("INVALID_AUDIT_ENDPOINT");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("INVALID_AUDIT_ENDPOINT");
  return { type: "tcp", host: match[1]!, port };
}

/**
 * 进程外审计写入端：append 只入有界队列并立即返回，连接层在后台把 NDJSON 发给独立 daemon。
 * 本对象没有存储路径也没有签名密钥——落盘文件与 HMAC secret 只属于 daemon 进程。
 */
export function createSocketAuditSink(options: SocketAuditSinkOptions): SocketAuditSink {
  const hash = options.hash ?? defaultHash;
  const queueLimit = options.queueLimit ?? 1024;
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new Error("INVALID_AUDIT_QUEUE_LIMIT");
  const endpoint = options.endpoint;
  const target = parseAuditEndpoint(endpoint);
  const token = options.token ?? process.env[AUDIT_CLIENT_TOKEN_ENV];
  if (typeof token !== "string" || token.length === 0) throw new Error("INVALID_AUDIT_CLIENT_TOKEN");

  const queue: WireRequest[] = [];
  const pending = new Map<string, Pending>();
  const entries: AuditEntry[] = [];
  let writer: Writer | undefined;
  let nextId = 0;
  let lastAckedSeq = -1;
  let drops = 0;
  let closed = false;
  let decoderBuffer = "";
  const decoder = new TextDecoder();

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readySettled = false;

  const handlers = {
    open(socket: unknown) {
      if (closed) {
        (socket as Writer).end();
        return;
      }
      writer = socket as Writer;
      if (!readySettled) {
        readySettled = true;
        resolveReady?.();
      }
      drain();
    },
    data(_socket: unknown, data: Uint8Array) {
      decoderBuffer += decoder.decode(data, { stream: true });
      let index = decoderBuffer.indexOf("\n");
      while (index >= 0) {
        const line = decoderBuffer.slice(0, index);
        decoderBuffer = decoderBuffer.slice(index + 1);
        index = decoderBuffer.indexOf("\n");
        if (line.length === 0) continue;
        let response: Record<string, unknown>;
        try {
          response = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = response.id === undefined ? undefined : String(response.id);
        if (id === undefined) continue;
        const waiter = pending.get(id);
        if (waiter === undefined) continue;
        pending.delete(id);
        if (response.ok === false) waiter.reject(new Error(String(response.error ?? "AUDIT_DAEMON_ERROR")));
        else waiter.resolve(response);
      }
    },
    error(socket: unknown, error: Error) {
      rejectPending(error);
      void socket;
    },
    connectError(socket: unknown, error: Error) {
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(error);
      }
      rejectPending(error);
      void socket;
    },
    close() {
      writer = undefined;
    },
  };

  function rejectPending(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  function drain(): void {
    if (writer === undefined) return;
    while (queue.length > 0) {
      wireWrite(writer, queue.shift()!);
    }
  }

  function wireWrite(targetWriter: Writer, request: WireRequest): void {
    targetWriter.write(`${JSON.stringify(request)}\n`);
  }

  function enqueue(request: WireRequest, expectReply: boolean): Promise<Record<string, unknown>> | undefined {
    if (closed) throw new Error("AUDIT_SINK_CLOSED");
    if (queue.length >= queueLimit) {
      drops += 1;
      return expectReply ? Promise.reject(new Error("AUDIT_QUEUE_FULL")) : undefined;
    }
    let id: string | undefined;
    let reply: Promise<Record<string, unknown>> | undefined;
    if (expectReply) {
      id = `r${(nextId += 1)}`;
      reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id!, { resolve, reject });
      });
    }
    const wire: WireRequest = { ...request, token, ...(id === undefined ? {} : { id }) };
    queue.push(wire);
    drain();
    return reply;
  }

  async function request(payload: WireRequest): Promise<Record<string, unknown>> {
    const reply = enqueue(payload, true);
    if (reply === undefined) throw new Error("AUDIT_QUEUE_FULL");
    return reply;
  }

  if (target.type === "unix") {
    void Bun.connect({ unix: target.path, socket: handlers }).catch((error: unknown) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(error instanceof Error ? error : new Error(String(error)));
      }
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
  } else {
    void Bun.connect({ hostname: target.host, port: target.port, socket: handlers }).catch((error: unknown) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(error instanceof Error ? error : new Error(String(error)));
      }
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  return {
    transport: "socket",
    endpoint,
    ready: () => readyPromise,
    ackedSeq: () => lastAckedSeq,
    appendAck: async (record: AuditRecord): Promise<AuditEntry> => {
      await readyPromise;
      const snapshot: AuditRecord = { ...record };
      const response = await request({ kind: "append", record: snapshot });
      const seq = Number(response.seq);
      if (response.ok !== true || !Number.isInteger(seq) || seq < 0) throw new Error("AUDIT_INVALID_ACK");
      lastAckedSeq = seq;
      const entry: AuditEntry = {
        seq,
        record: snapshot,
        prevHash: typeof response.prevHash === "string" ? response.prevHash : "0",
        hash: typeof response.hash === "string" ? response.hash : hash(fingerprint(seq, "0", snapshot)),
      };
      entries.push(entry);
      return { ...entry, record: { ...snapshot } };
    },
    flush: async () => {
      await readyPromise;
      await request({ kind: "ping" });
    },
    get entries(): readonly AuditEntry[] {
      return entries.map((entry) => ({ ...entry, record: { ...entry.record } }));
    },
    append(record: AuditRecord): AuditEntry {
      const seq = entries.length;
      const prevHash = seq === 0 ? "0" : entries[seq - 1]!.hash;
      const snapshot: AuditRecord = { ...record };
      const entry: AuditEntry = {
        seq,
        record: snapshot,
        prevHash,
        hash: hash(fingerprint(seq, prevHash, snapshot)),
      };
      entries.push(entry);
      enqueue({ kind: "append", record: snapshot }, false);
      return { ...entry, record: { ...snapshot } };
    },
    noteDrop(): void {
      drops += 1;
    },
    finalized(revision: number): FinalizedState {
      if (!Number.isInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
      if (revision > entries.length) return "incomplete";
      return drops > 0 ? "complete-with-drops" : "complete";
    },
    async finalizeRemote(revision: number, finalized: FinalizedState): Promise<SocketFinalizeResult> {
      await readyPromise;
      await request({ kind: "ping" });
      const response = await request({ kind: "finalize", revision, finalized });
      return {
        ok: response.ok === true,
        revision: Number(response.revision),
        seq: Number(response.seq),
      };
    },
    async verifyRemote(revision: number): Promise<AuditIntegrityResult> {
      await readyPromise;
      await request({ kind: "ping" });
      const response = await request({ kind: "verify", revision });
      const result = response.result as AuditIntegrityResult;
      return {
        ok: result.ok,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        entries: result.entries,
        ...(result.finalized === undefined ? {} : { finalized: result.finalized }),
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      const active = writer;
      if (active !== undefined) {
        while (queue.length > 0) wireWrite(active, queue.shift()!);
        active.end();
      }
      closed = true;
      writer = undefined;
      rejectPending(new Error("AUDIT_SINK_CLOSED"));
    },
  };
}
