import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** table 的品牌标记：仅 defineTable 可填入。 */
export declare const tableBrand: unique symbol;

export interface Table<T> {
  readonly [tableBrand]: true;
  readonly name: string;
}

/** 提交上下文：只在 transact 回调内有效，写入先暂存，回调成功后整批原子落后端。 */
export interface CommitContext {
  read<T>(table: Table<T>): T;
  write<T>(table: Table<T>, value: T): number;
  version(table: Table<unknown>): number;
}

export interface Store {
  readonly closed: boolean;
  defineTable<T>(name: string, initial: T): Table<T>;
  read<T>(table: Table<T>): T;
  version(table: Table<unknown>): number;
  /** 并发提交按调用顺序串行执行；回调内的全部写入一次性原子提交。 */
  transact<R>(work: (ctx: CommitContext) => R | Promise<R>): Promise<R>;
  commit<T>(table: Table<T>, value: T): Promise<number>;
  /** 幂等关闭：重复调用返回同一个 Promise。 */
  close(): Promise<void>;
}

/** 一次暂存写入的只读投影，供故障注入与审计使用。 */
export interface CommitWriteView {
  readonly table: string;
  readonly version: number;
  readonly value: unknown;
}

export interface StoreFaults {
  beforeCommit?(writes: readonly CommitWriteView[]): void | Promise<void>;
  duringCommit?(writes: readonly CommitWriteView[]): void | Promise<void>;
  /** 提交已落后端后触发：结果未知，需由 recover() 对账。 */
  afterCommit?(writes: readonly CommitWriteView[]): void | Promise<void>;
}

export interface StoreOptions {
  readonly faults?: StoreFaults;
}

export interface CommitRecord {
  readonly id: string;
  readonly seq: number;
  readonly writes: readonly CommitWriteView[];
  readonly createdAt: string;
}

export interface RecoveryReport {
  readonly state: "ready" | "unknown-outcome";
  readonly committed: string[];
  readonly retryable: string[];
}

export interface SqliteStoreOptions extends StoreOptions {
  readonly path: string;
  /** 租约/提交 id 的拥有者标识，崩溃恢复时用于区分写入者。 */
  readonly owner?: string;
  readonly now?: () => number;
}

export interface SqliteStore extends Store {
  pragma(name: string): string | number;
  readonly state: "ready" | "unknown-outcome";
  commits(): readonly CommitRecord[];
  /** 未对账的 outbox 意图（崩溃恢复窗口）。 */
  pending(): readonly CommitRecord[];
  recover(): RecoveryReport;
  checkpoint(): void;
}

interface StagedWrite {
  readonly table: Table<unknown>;
  readonly version: number;
  readonly value: unknown;
}

interface CommitHooks {
  before(writes: readonly CommitWriteView[]): Promise<void>;
  during(writes: readonly CommitWriteView[]): Promise<void>;
  after(writes: readonly CommitWriteView[]): Promise<void>;
}

const TABLES = new WeakSet<object>();
let storeSeed = 0;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertTable(table: unknown): asserts table is Table<unknown> {
  if (typeof table !== "object" || table === null || !TABLES.has(table)) {
    throw new Error("INVALID_TABLE");
  }
}

function views(writes: readonly StagedWrite[]): readonly CommitWriteView[] {
  return writes.map((write) => ({ table: write.table.name, version: write.version, value: write.value }));
}

function makeHooks(faults?: StoreFaults): CommitHooks {
  return {
    async before(writes) {
      await faults?.beforeCommit?.(writes);
    },
    async during(writes) {
      await faults?.duringCommit?.(writes);
    },
    async after(writes) {
      await faults?.afterCommit?.(writes);
    },
  };
}

/** 共享的暂存/排队/关闭骨架；后端只负责"整批原子落盘"与恢复语义。 */
function createStore(backend: {
  install(table: Table<unknown>, initial: unknown): void;
  read(table: Table<unknown>): unknown;
  version(table: Table<unknown>): number;
  commit(writes: readonly StagedWrite[], hooks: CommitHooks): Promise<void>;
  onClose?(): Promise<void> | void;
}, options: StoreOptions = {}): Store {
  const records = backend;
  const names = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const hooks = makeHooks(options.faults);

  function assertOpen(): void {
    if (closed) throw new Error("STORE_CLOSED");
  }

  function transact<R>(work: (ctx: CommitContext) => R | Promise<R>): Promise<R> {
    assertOpen();
    const run = queue.then(async () => {
      const staged = new Map<Table<unknown>, StagedWrite>();
      const ctx: CommitContext = {
        read<T>(table: Table<T>): T {
          assertTable(table);
          const pending = staged.get(table as Table<unknown>);
          return clone((pending === undefined ? records.read(table as Table<unknown>) : pending.value) as T);
        },
        write<T>(table: Table<T>, value: T): number {
          assertTable(table);
          const base = staged.get(table as Table<unknown>)?.version ?? records.version(table as Table<unknown>);
          const version = base + 1;
          staged.set(table as Table<unknown>, { table: table as Table<unknown>, version, value: clone(value) });
          return version;
        },
        version(table: Table<unknown>): number {
          assertTable(table);
          return staged.get(table)?.version ?? records.version(table);
        },
      };
      const result = await work(ctx);
      if (staged.size > 0) {
        const writes = [...staged.values()];
        await backend.commit(writes, hooks);
      }
      return result;
    });
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    get closed(): boolean {
      return closed;
    },
    defineTable<T>(name: string, initial: T): Table<T> {
      assertOpen();
      if (names.has(name)) throw new Error(`TABLE_EXISTS: ${name}`);
      const table = { name } as unknown as Table<T>;
      TABLES.add(table);
      names.add(name);
      backend.install(table as Table<unknown>, clone(initial));
      return table;
    },
    read<T>(table: Table<T>): T {
      assertTable(table);
      return clone(records.read(table as Table<unknown>) as T);
    },
    version(table: Table<unknown>): number {
      assertTable(table);
      return records.version(table);
    },
    transact,
    commit<T>(table: Table<T>, value: T): Promise<number> {
      assertTable(table);
      return transact((ctx) => ctx.write(table, value));
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = queue.then(async () => {
        closed = true;
        await backend.onClose?.();
      });
      return closing;
    },
  };
}

/** 进程内 store：写入串行排队，整批提交；故障注入可对账提交后故障。 */
export function openStore(options: StoreOptions = {}): Store {
  const values = new Map<Table<unknown>, { version: number; value: unknown }>();
  return createStore(
    {
      install(table, initial) {
        if (!values.has(table)) values.set(table, { version: 0, value: initial });
      },
      read(table) {
        const record = values.get(table);
        if (record === undefined) throw new Error("UNKNOWN_TABLE");
        return record.value;
      },
      version(table) {
        const record = values.get(table);
        if (record === undefined) throw new Error("UNKNOWN_TABLE");
        return record.version;
      },
      async commit(writes, hooks) {
        const writeViews = views(writes);
        await hooks.before(writeViews);
        await hooks.during(writeViews);
        for (const write of writes) {
          const record = values.get(write.table);
          if (record === undefined) throw new Error("UNKNOWN_TABLE");
          record.version = write.version;
          record.value = write.value;
        }
        await hooks.after(writeViews);
      },
    },
    options
  );
}

const META_VERSION = "1";

function metaGet(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function metaSet(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value
  );
}

function parseCommit(payload: string): CommitRecord {
  return JSON.parse(payload) as CommitRecord;
}

/** SQLite/WAL store：整批写入在一个事务内落盘，outbox 先于提交写入，提交后故障可恢复对账。 */
export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  const path = resolve(options.path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS tables (" +
      "name TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS commits (" +
      "id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS outbox (" +
      "id TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inflight')"
  );
  metaSet(db, "version", META_VERSION);
  const owner = options.owner ?? `${process.pid}:${++storeSeed}`;
  const now = options.now ?? Date.now;
  let idSeed = 0;

  function readRow(name: string): { version: number; value: unknown } | undefined {
    const row = db.query("SELECT version, value FROM tables WHERE name = ?").get(name) as
      | { version: number; value: string }
      | undefined;
    return row == null ? undefined : { version: row.version, value: JSON.parse(row.value) as unknown };
  }

  function nextSeq(): number {
    const row = db.query("SELECT max(seq) AS seq FROM commits").get() as { seq: number | null };
    return (row.seq ?? 0) + 1;
  }

  function state(): "ready" | "unknown-outcome" {
    const row = db.query("SELECT count(*) AS n FROM outbox WHERE status = 'inflight'").get() as { n: number };
    return row.n > 0 ? "unknown-outcome" : "ready";
  }

  let closed = false;
  const store = createStore(
    {
      install(table, initial) {
        if (readRow(table.name) === undefined) {
          db.query("INSERT INTO tables (name, version, value) VALUES (?, ?, ?)").run(
            table.name,
            0,
            JSON.stringify(initial)
          );
        }
      },
      read(table) {
        const row = readRow(table.name);
        if (row === undefined) throw new Error("UNKNOWN_TABLE");
        return row.value;
      },
      version(table) {
        const row = readRow(table.name);
        if (row === undefined) throw new Error("UNKNOWN_TABLE");
        return row.version;
      },
      async commit(writes, hooks) {
        const writeViews = views(writes);
        const seq = nextSeq();
        const id = `${seq}:${owner}:${++idSeed}`;
        const record: CommitRecord = {
          id,
          seq,
          writes: writeViews,
          createdAt: new Date(now()).toISOString(),
        };
        const payload = JSON.stringify(record);
        // outbox 意图先独立落盘：此后任一崩溃窗口都留一条可对账记录。
        db.exec("BEGIN IMMEDIATE");
        try {
          db.query("INSERT INTO outbox (id, seq, payload) VALUES (?, ?, ?)").run(id, seq, payload);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // 事务已结束；保留原始错误。
          }
          throw error;
        }
        await hooks.before(writeViews);
        db.exec("BEGIN IMMEDIATE");
        try {
          await hooks.during(writeViews);
          for (const write of writes) {
            db.query(
              "INSERT INTO tables (name, version, value) VALUES (?, ?, ?) " +
                "ON CONFLICT(name) DO UPDATE SET version = excluded.version, value = excluded.value"
            ).run(write.table.name, write.version, JSON.stringify(write.value));
          }
          db.query("INSERT INTO commits (id, seq, payload, created_at) VALUES (?, ?, ?, ?)").run(
            id,
            seq,
            payload,
            record.createdAt
          );
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // 事务已结束；保留原始错误。
          }
          throw error;
        }
        try {
          await hooks.after(writeViews);
        } catch (error) {
          // 提交已落 WAL 但 outbox 未清：交给 recover() 对账。
          throw error;
        }
        db.query("DELETE FROM outbox WHERE id = ?").run(id);
      },
      onClose() {
        if (!closed) {
          closed = true;
          db.close();
        }
      },
    },
    options
  ) as SqliteStore;

  Object.defineProperties(store, {
    state: { get: state, enumerable: true },
    pragma: {
      enumerable: true,
      value(name: string): string | number {
        const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
        const value = row?.[name];
        return typeof value === "number" ? value : String(value ?? "");
      },
    },
    commits: {
      enumerable: true,
      value(): readonly CommitRecord[] {
        const rows = db.query("SELECT payload FROM commits ORDER BY seq").all() as Array<{ payload: string }>;
        return rows.map((row) => parseCommit(row.payload));
      },
    },
    pending: {
      enumerable: true,
      value(): readonly CommitRecord[] {
        const rows = db.query("SELECT payload FROM outbox WHERE status = 'inflight' ORDER BY seq").all() as Array<{
          payload: string;
        }>;
        return rows.map((row) => parseCommit(row.payload));
      },
    },
    recover: {
      enumerable: true,
      value(): RecoveryReport {
        const rows = db.query("SELECT id, payload FROM outbox WHERE status = 'inflight'").all() as Array<{
          id: string;
          payload: string;
        }>;
        const committed: string[] = [];
        const retryable: string[] = [];
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            const hit = db.query("SELECT 1 AS hit FROM commits WHERE id = ?").get(row.id) as { hit: number } | null;
            (hit == null ? retryable : committed).push(row.id);
            db.query("DELETE FROM outbox WHERE id = ?").run(row.id);
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // 保留原始错误。
          }
          throw error;
        }
        return { state: state(), committed, retryable };
      },
    },
    checkpoint: {
      enumerable: true,
      value(): void {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      },
    },
  });
  return store;
}
