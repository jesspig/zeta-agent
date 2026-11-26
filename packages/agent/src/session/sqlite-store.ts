import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import type { CompactionLineage, SemanticRecap } from "@zeta-agent/agent-framework";
import {
  assertSessionFrame,
  createFrameId,
  createHeader,
  describeUnknownOutcome,
  DURABLE_UNKNOWN_VOCABULARY,
  leaseLockKey,
  projectSessionFrames,
  SESSION_STORE_VERSION,
  SessionStoreError,
  withPathLock,
  type AppendReceipt,
  type CasSessionLease,
  type MigrationResult,
  type PendingIntent,
  type RecapOptions,
  type RecoveryResult,
  type SessionFrame,
  type SessionHeader,
  type SessionLease,
  type SessionProjection,
  type SessionStore,
  type SessionStoreOptions,
  type SessionStoreState,
} from "./store";

export interface SqliteSessionStoreOptions extends SessionStoreOptions {
  readonly rootFrameId?: string;
}

export interface SqliteSessionStore extends SessionStore {
  pragma(name: string): string | number;
  frameCount(): number;
}

interface QueuedAppend {
  frame: SessionFrame;
  readonly advanceLeaf: boolean;
  resolve(receipt: AppendReceipt): void;
  reject(error: unknown): void;
}

function createDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function metaValue(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value
  );
}

function readFrames(db: Database): { frames: SessionFrame[]; badLines: number } {
  const exists = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'frames'")
    .get();
  if (exists === null || exists === undefined) return { frames: [], badLines: 0 };
  const rows = db.query("SELECT payload FROM frames ORDER BY seq").all() as Array<{ payload: string }>;
  const frames: SessionFrame[] = [];
  let badLines = 0;
  for (const row of rows) {
    try {
      const frame = JSON.parse(row.payload) as SessionFrame;
      assertSessionFrame(frame);
      frames.push(frame);
    } catch {
      badLines += 1;
    }
  }
  return { frames, badLines };
}

interface PendingRow extends PendingIntent {
  readonly status: string;
}

function readPending(db: Database): PendingRow[] {
  const rows = db.query("SELECT id, frame_id, payload, status FROM pending ORDER BY rowid").all() as Array<{
    id: string;
    frame_id: string;
    payload: string;
    status: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    frame: JSON.parse(row.payload) as SessionFrame,
  }));
}

function classify(error: unknown, phase: "lease" | "pending" | "before" | "frame"): SessionStoreError {
  if (error instanceof SessionStoreError) return error;
  if (phase === "lease" || phase === "pending" || phase === "before") {
    return new SessionStoreError("SESSION_RETRYABLE", `写入未提交：${String(error)}`);
  }
  return new SessionStoreError("SESSION_UNKNOWN_OUTCOME", `提交结果未知：${String(error)}`);
}

export function createSqliteSessionStore(options: SqliteSessionStoreOptions): SqliteSessionStore {
  const path = resolve(options.path);
  createDirectory(path);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 2000");
  // 未来版本保持只读：不为未知 schema 补表、不改写数据库。
  if (currentVersion() <= SESSION_STORE_VERSION) ensureLeaseTable();

  const leaseOwner = options.leaseOwner ?? `${process.pid}:${createFrameId()}`;
  const leaseTtlMs = options.leaseTtlMs ?? 2_000;
  const retryMs = options.retryMs ?? 500;
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? createFrameId;
  const createdAt = (): string => new Date(now()).toISOString();
  const defaultSessionId = options.sessionId ?? "zeta-session";
  let currentLease: CasSessionLease | undefined;
  let closed = false;
  let batch: QueuedAppend[] | undefined;
  let leafId: string | null = options.rootFrameId ?? null;

  function hasTable(name: string): boolean {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row !== null && row !== undefined;
  }

  /** leases 表是 CAS 租约权威状态；旧库缺表时补建，不改业务 frame。 */
  function ensureLeaseTable(): void {
    db.exec(
      "CREATE TABLE IF NOT EXISTS leases (" +
        "generation INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL)"
    );
  }

  function initialize(): void {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(
      "CREATE TABLE IF NOT EXISTS frames (" +
        "id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, parent_id TEXT, kind TEXT NOT NULL, " +
        "payload TEXT NOT NULL, created_at TEXT NOT NULL)"
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS pending (" +
        "id TEXT PRIMARY KEY, frame_id TEXT NOT NULL, payload TEXT NOT NULL, " +
        "status TEXT NOT NULL DEFAULT 'inflight')"
    );
    const header = createHeader(defaultSessionId, createdAt());
    setMeta(db, "version", String(header.version));
    setMeta(db, "session_id", header.sessionId);
    setMeta(db, "created_at", header.createdAt);
  }

  function currentVersion(): number {
    if (!hasTable("meta")) return 0;
    const raw = metaValue(db, "version");
    return raw === undefined ? 0 : Number(raw);
  }

  function header(): SessionHeader {
    if (closed) throw new SessionStoreError("SESSION_CLOSED", "SessionStore 已关闭");
    if (!hasTable("meta")) return createHeader(defaultSessionId, createdAt());
    return {
      format: "zeta-session-store",
      version: currentVersion(),
      sessionId: metaValue(db, "session_id") ?? defaultSessionId,
      createdAt: metaValue(db, "created_at") ?? createdAt(),
    };
  }

  function state(): SessionStoreState {
    const version = currentVersion();
    if (version > SESSION_STORE_VERSION) return "readonly";
    // 坏 payload / 未知 schemaVersion 不再被静默跳过：失败关闭为只读。
    if (readFrames(db).badLines > 0) return "readonly";
    if (!hasTable("pending")) return "ready";
    const row = db.query("SELECT count(*) AS n FROM pending WHERE status = 'inflight'").get() as { n: number };
    return row.n > 0 ? DURABLE_UNKNOWN_VOCABULARY.sessionUnknown : "ready";
  }

  function assertWritable(): void {
    if (closed) throw new SessionStoreError("SESSION_CLOSED", "SessionStore 已关闭");
    const current = state();
    if (current === "readonly") throw new SessionStoreError("SESSION_READONLY", "存储版本不受支持，保持只读");
    if (current === DURABLE_UNKNOWN_VOCABULARY.sessionUnknown) {
      throw new SessionStoreError(
        "SESSION_STATE_UNKNOWN_OUTCOME",
        describeUnknownOutcome("未知写入结果，须先 recover() 并对账")
      );
    }
  }

  function initializeIfNeeded(): void {
    const version = currentVersion();
    if (version > SESSION_STORE_VERSION) return;
    if (version === 0 && hasTable("legacy_frames")) {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const legacy = db.query("SELECT id, parent_id, payload FROM legacy_frames").all() as Array<{
        id: string;
        parent_id: string | null;
        payload: string;
      }>;
      initialize();
      legacy.forEach((row, index) => {
        const frame: SessionFrame = {
          id: row.id,
          seq: index + 1,
          parentId: row.parent_id,
          createdAt: createdAt(),
          kind: "message",
          message: JSON.parse(row.payload),
        };
        db.query(
          "INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(frame.id, frame.seq, frame.parentId, frame.kind, JSON.stringify(frame), frame.createdAt);
      });
      return;
    }
    if (version === 0 && !hasTable("meta")) initialize();
  }

  const versionAtOpen = currentVersion();
  initializeIfNeeded();

  function latestLease(): CasSessionLease | undefined {
    const row = db
      .query("SELECT generation, owner, expires_at, token FROM leases ORDER BY generation DESC LIMIT 1")
      .get() as { generation: number; owner: string; expires_at: number; token: string } | undefined;
    return row === null || row === undefined
      ? undefined
      : { generation: row.generation, owner: row.owner, expiresAt: row.expires_at, token: row.token };
  }

  async function acquireLease(): Promise<CasSessionLease> {
    // 重试截止时间用真实时钟：now() 只决定租约过期语义，冻结时钟时也必须能结束 BUSY 等待。
    const deadline = Date.now() + retryMs;
    for (;;) {
      const latest = latestLease();
      if (latest !== undefined && now() <= latest.expiresAt) {
        if (Date.now() > deadline) throw new SessionStoreError("SESSION_LEASE_BUSY", "租约被其他写入者持有");
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        continue;
      }
      const generation = (latest?.generation ?? 0) + 1;
      const lease: CasSessionLease = {
        owner: leaseOwner,
        expiresAt: now() + leaseTtlMs,
        generation,
        token: createFrameId(),
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        // 条件插入即 CAS：只有 observed generation 仍为空闲时才能写入新代次。
        const result = db
          .query(
            "INSERT INTO leases (generation, owner, expires_at, token) " +
              "SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM leases WHERE generation = ?)"
          )
          .run(generation, lease.owner, lease.expiresAt, lease.token, generation);
        db.exec("COMMIT");
        if (result.changes === 0) {
          if (Date.now() > deadline) throw new SessionStoreError("SESSION_LEASE_BUSY", "租约被其他写入者持有");
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          continue;
        }
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务已结束；保留原始错误。
        }
        throw classify(error, "lease");
      }
      if ((latestLease()?.generation ?? -1) > generation) {
        if (Date.now() > deadline) throw new SessionStoreError("SESSION_LEASE_BUSY", "租约被其他写入者持有");
        continue;
      }
      currentLease = lease;
      return lease;
    }
  }

  async function acquireLeaseWithFault(): Promise<CasSessionLease> {
    const lease = await acquireLease();
    try {
      await options.faults?.afterLeaseAcquire?.(lease);
    } catch (error) {
      releaseLease();
      throw new SessionStoreError("SESSION_RETRYABLE", `租约切点失败：${String(error)}`);
    }
    return lease;
  }

  function releaseLease(): void {
    const held = currentLease;
    if (held === undefined) return;
    // 迟到的 release 只删自己的代次，不得删除已接管 writer 的租约。
    db.query("DELETE FROM leases WHERE generation = ? AND token = ?").run(held.generation, held.token);
    currentLease = undefined;
  }

  function insertPending(entries: readonly QueuedAppend[]): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        db.query("INSERT INTO pending (id, frame_id, payload) VALUES (?, ?, ?)").run(
          entry.frame.id,
          entry.frame.id,
          JSON.stringify(entry.frame)
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已经结束；保留原始错误。
      }
      throw classify(error, "pending");
    }
  }

  function insertFrames(entries: readonly QueuedAppend[]): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        db.query(
          "INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          entry.frame.id,
          entry.frame.seq,
          entry.frame.parentId,
          entry.frame.kind,
          JSON.stringify(entry.frame),
          entry.frame.createdAt
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已经结束；保留原始错误。
      }
      throw classify(error, "frame");
    }
  }

  function cancelPending(rows: readonly { id: string }[]): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        db.query("UPDATE pending SET status = 'cancelled' WHERE id = ?").run(row.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已经结束；保留原始错误。
      }
      throw classify(error, "pending");
    }
  }

  function deletePending(rows: readonly { id: string }[]): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) db.query("DELETE FROM pending WHERE id = ?").run(row.id);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已经结束；保留原始错误。
      }
      throw classify(error, "frame");
    }
  }

  async function flush(): Promise<void> {
    const entries = batch ?? [];
    batch = undefined;
    if (entries.length === 0) return;
    let failure: unknown;
    await withPathLock(leaseLockKey(path, options.writerId), async () => {
      try {
        // 租约竞争失败也必须走同一 failure 出口，否则 append Promise 永不 settle。
        assertWritable();
        await acquireLeaseWithFault();
        // seq 与 parentId 在锁内按入队顺序解析；marker 保留自己的父节点。
        let seq = nextSeq();
        let parent = rootId();
        for (const entry of entries) {
          entry.frame = {
            ...entry.frame,
            seq,
            parentId: entry.advanceLeaf ? parent : entry.frame.parentId,
          };
          if (entry.advanceLeaf) parent = entry.frame.id;
          seq += 1;
        }
        insertPending(entries);
        try {
          await options.faults?.beforeCommit?.(entries.map((entry) => entry.frame));
        } catch (error) {
          throw classify(error, "before");
        }
        try {
          await options.faults?.duringCommit?.(entries.map((entry) => entry.frame));
        } catch (error) {
          throw classify(error, "frame");
        }
        insertFrames(entries);
        try {
          await options.faults?.afterCommit?.(entries.map((entry) => entry.frame));
        } catch (error) {
          throw classify(error, "frame");
        }
        deletePending(entries.map((entry) => ({ id: entry.frame.id })));
      } catch (error) {
        failure = error;
        if (error instanceof SessionStoreError && error.code === "SESSION_UNKNOWN_OUTCOME") {
          for (const entry of entries) {
            if (db.query("SELECT 1 AS hit FROM frames WHERE id = ?").get(entry.frame.id) !== null) {
              leafId = entry.frame.id;
            }
          }
        }
        if (error instanceof SessionStoreError && error.code === "SESSION_RETRYABLE") {
          try {
            cancelPending(entries.map((entry) => ({ id: entry.frame.id })));
          } catch {
            // pending 可能已由崩溃恢复清理；主错误保持不变。
          }
        }
      } finally {
        releaseLease();
      }
    });
    for (const entry of entries) {
      if (failure !== undefined) {
        entry.reject(failure);
      } else {
        if (entry.advanceLeaf) leafId = entry.frame.id;
        entry.resolve({ frameId: entry.frame.id, seq: entry.frame.seq, outcome: "committed" });
      }
    }
  }

  function enqueue(frame: SessionFrame, advanceLeaf = true): Promise<AppendReceipt> {
    return new Promise<AppendReceipt>((resolve, reject) => {
      batch ??= [];
      batch.push({ frame, advanceLeaf, resolve, reject });
      if (batch.length === 1) queueMicrotask(() => void flush());
    });
  }

  function nextSeq(): number {
    const row = db.query("SELECT max(seq) AS seq FROM frames").get() as { seq: number | null };
    return (row.seq ?? 0) + 1;
  }

  function buildFrame(kind: SessionFrame["kind"], parentId: string | null, extras: Record<string, unknown>): SessionFrame {
    const frame = { id: idFactory(), seq: nextSeq(), parentId, createdAt: createdAt(), kind, ...extras };
    assertSessionFrame(frame);
    return frame;
  }

  function rootId(): string | null {
    if (leafId !== null) return leafId;
    const row = db.query("SELECT id FROM frames ORDER BY seq DESC LIMIT 1").get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  function view(rootFrameId: string): SqliteSessionStore {
    return createSqliteSessionStore({ ...options, rootFrameId, idFactory, leaseOwner });
  }

  const store: SqliteSessionStore = {
    get header() {
      return header();
    },
    get version() {
      return header().version;
    },
    get state() {
      return state();
    },
    get sessionId() {
      return header().sessionId;
    },
    pragma(name) {
      const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
      const value = row?.[name];
      return typeof value === "number" ? value : String(value ?? "");
    },
    frameCount() {
      const row = db.query("SELECT count(*) AS n FROM frames").get() as { n: number };
      return row.n;
    },
    append(message) {
      try {
        assertWritable();
        return enqueue(buildFrame("message", rootId(), { message }));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    appendRecap(recap: SemanticRecap, uris: readonly string[], recapOptions?: RecapOptions) {
      try {
        assertWritable();
        const lineage: CompactionLineage = {
          threshold: recapOptions?.threshold ?? 0,
          recap,
          uris: [...uris],
          preTokenCount: recapOptions?.preTokenCount ?? 0,
        };
        return enqueue(buildFrame("recap", rootId(), { recap, uris: [...uris], lineage }));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    projection(projOptions?: { readonly fromId?: string }): SessionProjection {
      const { frames, badLines } = readFrames(db);
      const fromId = projOptions?.fromId ?? leafId ?? undefined;
      return projectSessionFrames(frames, { ...(fromId === undefined ? {} : { fromId }), badLines });
    },
    resume(frameId) {
      if (!readFrames(db).frames.some((frame) => frame.id === frameId)) {
        throw new SessionStoreError("SESSION_FRAME_NOT_FOUND", `frame 不存在：${frameId}`);
      }
      return view(frameId);
    },
    async fork(fromId) {
      assertWritable();
      const parentId = fromId ?? rootId();
      const frame = buildFrame("fork", parentId, { fromId: parentId });
      const receipt = await enqueue(frame, false);
      return view(receipt.frameId);
    },
    async truncate(frameId) {
      assertWritable();
      if (!readFrames(db).frames.some((frame) => frame.id === frameId)) {
        throw new SessionStoreError("SESSION_FRAME_NOT_FOUND", `frame 不存在：${frameId}`);
      }
      const frame = buildFrame("truncate", frameId, { fromId: frameId });
      const receipt = await enqueue(frame, false);
      return view(receipt.frameId);
    },
    clone(destination) {
      const target = resolve(destination);
      if (target === path) throw new SessionStoreError("SESSION_INVALID_FRAME", "clone 目的地不能与源相同");
      createDirectory(target);
      const cloneDb = new Database(target);
      try {
        cloneDb.exec("PRAGMA journal_mode = WAL");
        cloneDb.exec("PRAGMA synchronous = FULL");
        initializeOn(cloneDb, header().sessionId, createdAt());
        const { frames } = readFrames(db);
        const idMap = new Map(frames.map((frame) => [frame.id, idFactory()]));
        cloneDb.exec("BEGIN IMMEDIATE");
        try {
          frames.forEach((frame, index) => {
            const cloned: SessionFrame = {
              ...frame,
              id: idMap.get(frame.id)!,
              seq: index + 1,
              parentId: frame.parentId === null ? null : (idMap.get(frame.parentId) ?? null),
              createdAt: createdAt(),
            };
            cloneDb
              .query("INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
              .run(cloned.id, cloned.seq, cloned.parentId, cloned.kind, JSON.stringify(cloned), cloned.createdAt);
          });
          cloneDb.exec("COMMIT");
        } catch (error) {
          cloneDb.exec("ROLLBACK");
          throw error;
        }
      } finally {
        cloneDb.close();
      }
      return createSqliteSessionStore({ ...options, path: target, rootFrameId: undefined });
    },
    async recover(): Promise<RecoveryResult> {
      if (closed) throw new SessionStoreError("SESSION_CLOSED", "SessionStore 已关闭");
      return withPathLock(leaseLockKey(path, options.writerId), async () => {
        await acquireLeaseWithFault();
        try {
          const pending = readPending(db);
          const ids = new Set(readFrames(db).frames.map((frame) => frame.id));
          const committed: string[] = [];
          const retryable: string[] = [];
          for (const intent of pending) {
            if (intent.status === "cancelled") {
              retryable.push(intent.frame.id);
              continue;
            }
            if (ids.has(intent.frame.id)) committed.push(intent.frame.id);
            else retryable.push(intent.frame.id);
          }
          deletePending(pending.map((intent) => ({ id: intent.id })));
          return { state: state(), committed, retryable, badLines: readFrames(db).badLines };
        } finally {
          releaseLease();
        }
      });
    },
    lease() {
      return currentLease;
    },
    pendingIntents() {
      return hasTable("pending") ? readPending(db) : [];
    },
    migrate(): MigrationResult {
      const from = versionAtOpen;
      if (from > SESSION_STORE_VERSION) return { from, to: from, migrated: false };
      initializeIfNeeded();
      return { from, to: currentVersion(), migrated: from < currentVersion() };
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  function initializeOn(target: Database, sessionId: string, nowCreatedAt: string): void {
    target.exec("CREATE TABLE IF NOT EXISTS leases (generation INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL)");
    target.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    target.exec(
      "CREATE TABLE IF NOT EXISTS frames (" +
        "id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, parent_id TEXT, kind TEXT NOT NULL, " +
        "payload TEXT NOT NULL, created_at TEXT NOT NULL)"
    );
    target.exec(
      "CREATE TABLE IF NOT EXISTS pending (" +
        "id TEXT PRIMARY KEY, frame_id TEXT NOT NULL, payload TEXT NOT NULL, " +
        "status TEXT NOT NULL DEFAULT 'inflight')"
    );
    setMeta(target, "version", String(SESSION_STORE_VERSION));
    setMeta(target, "session_id", sessionId);
    setMeta(target, "created_at", nowCreatedAt);
  }

  return store;
}
