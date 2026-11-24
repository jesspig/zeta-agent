import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineDocument,
  openDocument,
  openSqliteStore,
  openStore,
  transactDocuments,
  type SqliteStore,
} from "./index";

const dirs: string[] = [];
const openStores: SqliteStore[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-object-store-"));
  dirs.push(dir);
  return join(dir, "objects.sqlite");
}
function tracked(store: SqliteStore): SqliteStore {
  openStores.push(store);
  return store;
}
afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("T-19/store: 多文档原子事务与 group commit", () => {
  test("同事务多文档全部提交；before/during 故障零部分提交", async () => {
    const store = openStore();
    const a = defineDocument({ name: "a", initial: { n: 0 } });
    const b = defineDocument({ name: "b", initial: { n: 0 } });
    const ha = openDocument(store, a);
    const hb = openDocument(store, b);

    await transactDocuments(store, (tx) => {
      tx.put(ha, { n: 1 });
      tx.put(hb, { n: 1 });
    });
    expect(store.read(ha.table)).toEqual({ n: 1 });
    expect(store.read(hb.table)).toEqual({ n: 1 });

    const before = openStore({
      faults: {
        beforeCommit() {
          throw new Error("fault-before");
        },
      },
    });
    const ba = openDocument(before, a);
    const bb = openDocument(before, b);
    await expect(
      transactDocuments(before, (tx) => {
        tx.put(ba, { n: 1 });
        tx.put(bb, { n: 1 });
      })
    ).rejects.toThrow("fault-before");
    expect(before.read(ba.table)).toEqual({ n: 0 });
    expect(before.read(bb.table)).toEqual({ n: 0 });

    const injected = openStore({
      faults: {
        duringCommit() {
          throw new Error("fault-during");
        },
      },
    });
    const ia = openDocument(injected, a);
    const ib = openDocument(injected, b);
    await expect(
      transactDocuments(injected, (tx) => {
        tx.put(ia, { n: 9 });
        tx.put(ib, { n: 9 });
      })
    ).rejects.toThrow("fault-during");
    expect(injected.read(ia.table)).toEqual({ n: 0 });
    expect(injected.read(ib.table)).toEqual({ n: 0 });
    expect(injected.version(ia.table)).toBe(0);
    expect(injected.version(ib.table)).toBe(0);
  });

  test("abort/throw 不产生任何文档写入", async () => {
    const store = openStore();
    const a = defineDocument({ name: "a", initial: { n: 0 } });
    const b = defineDocument({ name: "b", initial: { n: 0 } });
    const ha = openDocument(store, a);
    const hb = openDocument(store, b);
    await expect(
      transactDocuments(store, (tx) => {
        tx.put(ha, { n: 1 });
        tx.abort("nope");
      })
    ).resolves.toBeUndefined();
    expect(store.read(ha.table)).toEqual({ n: 0 });
    expect(store.read(hb.table)).toEqual({ n: 0 });
    await expect(
      transactDocuments(store, (tx) => {
        tx.put(hb, { n: 1 });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(store.read(hb.table)).toEqual({ n: 0 });
  });
});

describe("T-19/store: SQLite WAL、outbox、提交后故障恢复", () => {
  test("group commit 落 WAL；afterCommit 故障进入 unknown-outcome，recover 判定已提交", async () => {
    let store: SqliteStore | undefined;
    store = tracked(
      openSqliteStore({
        path: tempPath(),
        faults: {
          afterCommit() {
            throw new Error("crash-after-commit");
          },
        },
      })
    );
    const a = defineDocument({ name: "a", initial: { n: 0 } });
    const ha = openDocument(store, a);
    await expect(
      transactDocuments(store, (tx) => {
        tx.put(ha, { n: 42 });
      })
    ).rejects.toThrow("crash-after-commit");
    expect(store.state).toBe("unknown-outcome");
    expect(store.pending().length).toBe(1);
    const report = store.recover();
    expect(report.committed.length).toBe(1);
    expect(report.retryable.length).toBe(0);
    expect(store.state).toBe("ready");
    expect(store.read(ha.table)).toEqual({ n: 42 });
    expect(store.pragma("journal_mode")).toBe("wal");
    await store.close();
  });

  test("beforeCommit 故障 → outbox 可重试；重开后数据未变", async () => {
    const path = tempPath();
    let store: SqliteStore | undefined = tracked(
      openSqliteStore({
        path,
        faults: {
          beforeCommit() {
            throw new Error("crash-before-commit");
          },
        },
      })
    );
    const a = defineDocument({ name: "a", initial: { n: 0 } });
    const ha = openDocument(store, a);
    await expect(
      transactDocuments(store, (tx) => {
        tx.put(ha, { n: 7 });
      })
    ).rejects.toThrow("crash-before-commit");
    const report = store.recover();
    expect(report.retryable.length).toBe(1);
    expect(report.committed.length).toBe(0);
    await store.close();

    store = tracked(openSqliteStore({ path }));
    const reopened = openDocument(store, a);
    expect(store.read(reopened.table)).toEqual({ n: 0 });
    expect(store.state).toBe("ready");
    await store.close();
  });

  test("SQLite 多文档事务遇故障无部分提交；恢复后整批重试", async () => {
    const path = tempPath();
    let store: SqliteStore = tracked(
      openSqliteStore({
        path,
        faults: {
          duringCommit() {
            throw new Error("crash-mid-commit");
          },
        },
      })
    );
    const a = defineDocument({ name: "a", initial: { n: 0 } });
    const b = defineDocument({ name: "b", initial: { n: 0 } });
    let ha = openDocument(store, a);
    let hb = openDocument(store, b);
    await expect(
      transactDocuments(store, (tx) => {
        tx.put(ha, { n: 100 });
        tx.put(hb, { n: 200 });
      })
    ).rejects.toThrow("crash-mid-commit");
    expect(store.read(ha.table)).toEqual({ n: 0 });
    expect(store.read(hb.table)).toEqual({ n: 0 });
    expect(store.version(ha.table)).toBe(0);
    expect(store.version(hb.table)).toBe(0);
    expect(store.recover().retryable.length).toBe(1);
    await store.close();

    store = tracked(openSqliteStore({ path }));
    ha = openDocument(store, a);
    hb = openDocument(store, b);
    await transactDocuments(store, (tx) => {
      tx.put(ha, { n: 100 });
      tx.put(hb, { n: 200 });
    });
    expect(store.read(ha.table)).toEqual({ n: 100 });
    expect(store.read(hb.table)).toEqual({ n: 200 });
    await store.close();
  });

  test("WAL 提交记录 seq 单调；checkpoint 后可读", async () => {
    const store = tracked(openSqliteStore({ path: tempPath() }));
    const a = defineDocument({ name: "a", initial: 0 });
    const ha = openDocument(store, a);
    await store.commit(ha.table, 1);
    await store.commit(ha.table, 2);
    const commits = store.commits();
    expect(commits.length).toBe(2);
    expect(commits[0]!.seq).toBeLessThan(commits[1]!.seq);
    store.checkpoint();
    expect(store.read(ha.table)).toBe(2);
    await store.close();
  });
});
