import { canonicalString } from "./contract";
import type { CommitContext, Store, Table } from "./store";

/** 文档定义与句柄的品牌标记：外部无法伪造。 */
export declare const documentBrand: unique symbol;
export declare const documentHandleBrand: unique symbol;

export interface DocumentDef<Doc> {
  readonly [documentBrand]: true;
  readonly name: string;
  readonly version: string;
  readonly initial: Doc;
}

export interface DocumentHandle<Doc> {
  readonly [documentHandleBrand]: true;
  readonly definition: DocumentDef<Doc>;
  readonly name: string;
  readonly table: Table<Doc | null>;
}

export interface Tx {
  readonly aborted: boolean;
  /** 取得可变草稿；同一事务对同一对象返回同一份草稿。 */
  draft<Doc>(handle: DocumentHandle<Doc>): Doc;
  put<Doc>(handle: DocumentHandle<Doc>, value: Doc): void;
  /** 退休对象：提交 null，get 返回 null。 */
  retire<Doc>(handle: DocumentHandle<Doc>): void;
  /** 事务内优先读草稿，否则读已提交值；退休后为 null。 */
  get<Doc>(handle: DocumentHandle<Doc>): Doc | null;
  abort(reason?: string): void;
}

export interface DocumentSpec<Doc> {
  readonly name: string;
  readonly version?: string;
  readonly initial: Doc;
}

interface DraftEntry {
  base: unknown;
  current: unknown;
  retired: boolean;
}

const DEFS = new WeakSet<object>();
const HANDLES = new WeakSet<object>();
/** 进程内单写者锁：同一对象在任意时刻只有一个可写草稿。 */
const activeDrafts = new WeakSet<object>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function defineDocument<Doc>(spec: DocumentSpec<Doc>): DocumentDef<Doc> {
  const def = {
    name: spec.name,
    version: spec.version ?? "1.0",
    initial: clone(spec.initial),
  } as unknown as DocumentDef<Doc>;
  DEFS.add(def);
  return Object.freeze(def);
}

export function openDocument<Doc>(store: Store, def: DocumentDef<Doc>): DocumentHandle<Doc> {
  if (!DEFS.has(def)) throw new Error("FORGED_DOCUMENT_DEF");
  const table = store.defineTable<Doc | null>(`document:${def.name}`, def.initial);
  const handle = {
    name: def.name,
    definition: def,
    table,
  } as unknown as DocumentHandle<Doc>;
  HANDLES.add(handle);
  return Object.freeze(handle);
}

export function transact<R>(store: Store, work: (tx: Tx) => R | Promise<R>): Promise<R> {
  return store.transact(async (ctx: CommitContext) => {
    const drafts = new Map<DocumentHandle<unknown>, DraftEntry>();
    let aborted = false;

    function assertHandle(handle: unknown): asserts handle is DocumentHandle<unknown> {
      if (typeof handle !== "object" || handle === null || !HANDLES.has(handle)) {
        throw new Error("INVALID_DOCUMENT_HANDLE");
      }
    }

    function entryOf(handle: DocumentHandle<unknown>): DraftEntry {
      const existing = drafts.get(handle);
      if (existing !== undefined) return existing;
      if (activeDrafts.has(handle)) throw new Error("SINGLE_WRITER_VIOLATION");
      const base = ctx.read(handle.table) as unknown;
      const entry: DraftEntry = { base, current: clone(base), retired: false };
      drafts.set(handle, entry);
      activeDrafts.add(handle);
      return entry;
    }

    const tx: Tx = {
      get aborted(): boolean {
        return aborted;
      },
      draft<Doc>(handle: DocumentHandle<Doc>): Doc {
        assertHandle(handle);
        if (aborted) throw new Error("TX_ABORTED");
        return entryOf(handle as DocumentHandle<unknown>).current as Doc;
      },
      put<Doc>(handle: DocumentHandle<Doc>, value: Doc): void {
        assertHandle(handle);
        if (aborted) throw new Error("TX_ABORTED");
        const entry = entryOf(handle as DocumentHandle<unknown>);
        entry.current = clone(value);
        entry.retired = false;
      },
      retire<Doc>(handle: DocumentHandle<Doc>): void {
        assertHandle(handle);
        if (aborted) throw new Error("TX_ABORTED");
        entryOf(handle as DocumentHandle<unknown>).retired = true;
      },
      get<Doc>(handle: DocumentHandle<Doc>): Doc | null {
        assertHandle(handle);
        const entry = drafts.get(handle as DocumentHandle<unknown>);
        if (entry !== undefined) {
          return entry.retired ? null : (clone(entry.current) as Doc);
        }
        return ctx.read(handle.table) as Doc | null;
      },
      abort(reason?: string): void {
        aborted = true;
        if (reason !== undefined) {
          // 保留原因供调用方诊断，但不影响丢弃语义。
          void reason;
        }
      },
    };

    try {
      const result = await work(tx);
      if (!aborted) {
        for (const [handle, entry] of drafts) {
          if (entry.retired) {
            if (canonicalString(entry.base) !== "null") {
              ctx.write(handle.table, null as never);
            }
          } else if (canonicalString(entry.base) !== canonicalString(entry.current)) {
            ctx.write(handle.table, entry.current as never);
          }
        }
      }
      return result;
    } finally {
      for (const handle of drafts.keys()) activeDrafts.delete(handle);
    }
  });
}
