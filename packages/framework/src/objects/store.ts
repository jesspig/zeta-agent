/** table 的品牌标记：仅 defineTable 可填入。 */
export declare const tableBrand: unique symbol;

export interface Table<T> {
  readonly [tableBrand]: true;
  readonly name: string;
}

/** 提交上下文：只在 transact 回调内有效，写入直接落后端，避免重入排队。 */
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
  /** 并发提交按调用顺序串行执行；回调收到可直接读写的提交上下文。 */
  transact<R>(work: (ctx: CommitContext) => R | Promise<R>): Promise<R>;
  commit<T>(table: Table<T>, value: T): Promise<number>;
  /** 幂等关闭：重复调用返回同一个 Promise。 */
  close(): Promise<void>;
}

interface TableRecord {
  version: number;
  value: unknown;
}

const TABLES = new WeakSet<object>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function openStore(): Store {
  const records = new Map<Table<unknown>, TableRecord>();
  const names = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  function assertOpen(): void {
    if (closed) throw new Error("STORE_CLOSED");
  }

  function assertTable(table: unknown): asserts table is Table<unknown> {
    if (typeof table !== "object" || table === null || !TABLES.has(table)) {
      throw new Error("INVALID_TABLE");
    }
  }

  function recordOf(table: Table<unknown>): TableRecord {
    const record = records.get(table);
    if (record === undefined) throw new Error("UNKNOWN_TABLE");
    return record;
  }

  function makeContext(): CommitContext {
    return {
      read<T>(table: Table<T>): T {
        assertTable(table);
        return clone(recordOf(table as Table<unknown>).value) as T;
      },
      write<T>(table: Table<T>, value: T): number {
        assertTable(table);
        const record = recordOf(table as Table<unknown>);
        record.version += 1;
        record.value = clone(value);
        return record.version;
      },
      version(table: Table<unknown>): number {
        assertTable(table);
        return recordOf(table).version;
      },
    };
  }

  function transact<R>(work: (ctx: CommitContext) => R | Promise<R>): Promise<R> {
    assertOpen();
    const run = queue.then(() => work(makeContext()));
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
      records.set(table as Table<unknown>, { version: 0, value: clone(initial) });
      return table;
    },
    read<T>(table: Table<T>): T {
      assertTable(table);
      return clone(recordOf(table as Table<unknown>).value) as T;
    },
    version(table: Table<unknown>): number {
      assertTable(table);
      return recordOf(table).version;
    },
    transact,
    commit<T>(table: Table<T>, value: T): Promise<number> {
      assertTable(table);
      return transact((ctx) => ctx.write(table, value));
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = queue.then(() => {
        closed = true;
      });
      return closing;
    },
  };
}
