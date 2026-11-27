import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";

export interface SpoolEntry<T> {
  readonly id: string;
  readonly value: T;
}

export interface SpoolLoadOptions {
  readonly limit?: number;
  readonly excludeIds?: readonly string[];
}

export interface TelemetrySpool<T> {
  load(options?: SpoolLoadOptions): Promise<readonly SpoolEntry<T>[]>;
  enqueue(value: T): Promise<SpoolEntry<T>>;
  ack(id: string): Promise<void>;
  compact(): Promise<void>;
  close(): Promise<void>;
}

export interface FileTelemetrySpoolOptions {
  readonly path: string;
  readonly createId?: () => string;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface FileTelemetrySpool<T> extends TelemetrySpool<T> {
  readonly path: string;
}

type SpoolRecord<T> =
  | { readonly type: "enqueue"; readonly id: string; readonly value: T }
  | { readonly type: "ack"; readonly id: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function corruptLine(lineNumber: number, cause: unknown): Error {
  return new Error(`TELEMETRY_SPOOL_CORRUPT_LINE: ${lineNumber}`, { cause });
}

function parseRecords<T>(text: string): Map<string, SpoolEntry<T>> {
  const pending = new Map<string, SpoolEntry<T>>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw corruptLine(index + 1, cause);
    }
    if (typeof value !== "object" || value === null) throw corruptLine(index + 1, new Error("not an object"));
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw corruptLine(index + 1, new Error("missing id"));
    }
    if (record.type === "enqueue") {
      if (!("value" in record)) throw corruptLine(index + 1, new Error("missing value"));
      pending.set(record.id, Object.freeze({ id: record.id, value: record.value as T }));
    } else if (record.type === "ack") {
      pending.delete(record.id);
    } else {
      throw corruptLine(index + 1, new Error("unknown record type"));
    }
  }
  return pending;
}

export function telemetrySpoolLockPort(path: string): number {
  const resolved = resolve(path);
  const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(identity).digest();
  return 20_000 + hash.readUInt16BE(0) % 40_000;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function acquirePortLock(port: number, timeoutMs: number, retryMs: number): Promise<Server> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await listen(server, port);
      return server;
    } catch (error) {
      if (errorCode(error) !== "EADDRINUSE") throw error;
      if (Date.now() >= deadline) throw new Error("TELEMETRY_SPOOL_LOCK_TIMEOUT");
      await sleep(retryMs);
    }
  }
}

function closePortLock(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}

async function truncateFile(path: string, length: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverTornTail(path: string, data: Buffer): Promise<string> {
  if (data.length === 0 || data[data.length - 1] === 0x0a) return data.toString("utf8");
  const tailStart = data.lastIndexOf(0x0a) + 1;
  const tail = data.subarray(tailStart);
  try {
    JSON.parse(tail.toString("utf8"));
    return data.toString("utf8");
  } catch {
    await truncateFile(path, tailStart);
    return data.subarray(0, tailStart).toString("utf8");
  }
}

async function findTailStart(handle: FileHandle, size: number): Promise<number> {
  let position = size;
  while (position > 0) {
    const length = Math.min(4096, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    await handle.read(chunk, 0, length, position);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return position + newline + 1;
  }
  return 0;
}

async function prepareAppend(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  if (info.size === 0) return;
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, info.size - 1);
  if (last[0] === 0x0a) return;
  const tailStart = await findTailStart(handle, info.size);
  const tail = Buffer.alloc(info.size - tailStart);
  await handle.read(tail, 0, tail.length, tailStart);
  let validTail = false;
  try {
    JSON.parse(tail.toString("utf8"));
    validTail = true;
  } catch {
    validTail = false;
  }
  if (validTail) await handle.writeFile("\n", "utf8");
  else await handle.truncate(tailStart);
}

async function appendRecord<T>(path: string, record: SpoolRecord<T>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a+");
  try {
    await prepareAppend(handle);
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFileTelemetrySpool<T>(options: FileTelemetrySpoolOptions): FileTelemetrySpool<T> {
  const path = options.path;
  const port = telemetrySpoolLockPort(path);
  const createId = options.createId ?? randomUUID;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const lockRetryMs = options.lockRetryMs ?? 10;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 ||
      !Number.isFinite(lockRetryMs) || lockRetryMs <= 0) {
    throw new RangeError("invalid telemetry spool lock timing");
  }
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let heldServer: Server | undefined;
  let acquiring: Promise<Server> | undefined;

  const serialize = <R>(operation: () => Promise<R>): Promise<R> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensureLock = (): Promise<Server> => {
    if (heldServer !== undefined) return Promise.resolve(heldServer);
    if (acquiring !== undefined) return acquiring;
    acquiring = acquirePortLock(port, lockTimeoutMs, lockRetryMs).then((server) => {
      heldServer = server;
      return server;
    }).finally(() => {
      acquiring = undefined;
    });
    return acquiring;
  };

  const withLock = async <R>(operation: () => Promise<R>): Promise<R> => {
    if (closed) throw new Error("TELEMETRY_SPOOL_CLOSED");
    await ensureLock();
    return operation();
  };

  const loadInternal = async (loadOptions: SpoolLoadOptions = {}): Promise<readonly SpoolEntry<T>[]> => {
    const limit = loadOptions.limit ?? Number.POSITIVE_INFINITY;
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError("spool load limit must be a non-negative safe integer");
    }
    if (limit === 0) return [];
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const text = await recoverTornTail(path, data);
    const excluded = new Set(loadOptions.excludeIds ?? []);
    const entries: SpoolEntry<T>[] = [];
    for (const entry of parseRecords<T>(text).values()) {
      if (excluded.has(entry.id)) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return Object.freeze(entries);
  };

  return {
    path,
    load(loadOptions = {}): Promise<readonly SpoolEntry<T>[]> {
      return serialize(() => withLock(() => loadInternal(loadOptions)));
    },
    enqueue(value: T): Promise<SpoolEntry<T>> {
      return serialize(() => withLock(async () => {
        const id = createId();
        if (id.length === 0) throw new Error("TELEMETRY_SPOOL_EMPTY_ID");
        const entry: SpoolEntry<T> = Object.freeze({ id, value });
        await appendRecord(path, { type: "enqueue", ...entry });
        return entry;
      }));
    },
    ack(id: string): Promise<void> {
      if (id.length === 0) return Promise.reject(new Error("TELEMETRY_SPOOL_EMPTY_ID"));
      return serialize(() => withLock(() => appendRecord(path, { type: "ack", id })));
    },
    compact(): Promise<void> {
      return serialize(() => withLock(async () => {
        const entries = await loadInternal();
        const content = entries.map((entry) => JSON.stringify({ type: "enqueue", ...entry })).join("\n") +
          (entries.length > 0 ? "\n" : "");
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(temporary, "wx");
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        await syncDirectory(dirname(path));
      }));
    },
    close(): Promise<void> {
      return serialize(async () => {
        closed = true;
        const server = heldServer;
        heldServer = undefined;
        if (server !== undefined) await closePortLock(server);
      });
    },
  };
}
