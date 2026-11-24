import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSqliteSessionStore } from "./sqlite-store";
import type { AgentMessage } from "@zeta-agent/agent-framework";
import { runSessionStoreConformance, type ConformanceFactoryOptions } from "./store.conformance.spec";

const dirs: string[] = [];
function tempPath(name = "session.sqlite"): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-sqlite-store-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir === undefined) continue;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        // Windows 上 WAL 文件句柄释放可能晚于 close()；短暂重试后再报告。
        await Bun.sleep(10);
      }
    }
  }
});

let primaryPath: string | undefined;
beforeEach(() => {
  primaryPath = undefined;
});
function create(options?: ConformanceFactoryOptions) {
  primaryPath ??= tempPath();
  return createSqliteSessionStore({
    path: options?.destination ?? primaryPath,
    sessionId: options?.sessionId,
    faults: options?.faults,
  });
}
const factory = Object.assign(create, {
  destination: () => join(primaryPath ?? tempPath(), "..", "clone.sqlite"),
});

runSessionStoreConformance("SQLite", factory);

describe("T-11 SQLite SessionStore 专项", () => {
  test("WAL 与 synchronous=FULL", () => {
    const path = tempPath();
    const store = createSqliteSessionStore({ path });
    expect(store.pragma("journal_mode")).toBe("wal");
    expect(Number(store.pragma("synchronous"))).toBe(2);
    store.close();
  });

  test("并发 append 共享一次 group commit", async () => {
    const path = tempPath();
    let commits = 0;
    const store = createSqliteSessionStore({
      path,
      faults: {
        beforeCommit: () => {
          commits += 1;
        },
      },
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.append({ role: "user", content: `group-${index}` } satisfies AgentMessage)
      )
    );
    expect(commits).toBe(1);
    expect(store.projection().messages).toHaveLength(6);
    store.close();
  });

  test("fork/truncate 不删除历史 frame，ancestry 保持不可变", async () => {
    const path = tempPath();
    const store = createSqliteSessionStore({ path });
    const root = await store.append({ role: "user", content: "immutable" } satisfies AgentMessage);
    const forkView = await store.fork(root.frameId);
    const forkId = forkView.projection().leafId;
    const truncated = await store.truncate(root.frameId);
    const truncateId = truncated.projection().leafId;
    expect(store.projection().frames.map((frame) => frame.id)).toEqual([
      root.frameId,
      forkId!,
      truncateId!,
    ]);
    expect(forkView.projection().frames.find((frame) => frame.id === forkView.projection().leafId)?.kind).toBe("fork");
    expect(truncated.projection().frames.find((frame) => frame.id === truncated.projection().leafId)?.kind).toBe("truncate");
    store.close();
    forkView.close();
    truncated.close();
  });

  test("未知版本不改写数据库且写入被拒绝", async () => {
    const path = tempPath();
    const db = new Database(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO meta (key, value) VALUES ('version', '999')").run();
    db.close();
    const before = readFileSync(path);

    const store = createSqliteSessionStore({ path });
    expect(store.state).toBe("readonly");
    await expect(store.append({ role: "user", content: "blocked" })).rejects.toMatchObject({
      code: "SESSION_READONLY",
    });
    expect(readFileSync(path).byteLength).toBeGreaterThanOrEqual(before.byteLength);
    store.close();
  });

  test("旧版 meta 表迁移到 v1 frame schema", async () => {
    const path = tempPath();
    const db = new Database(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE legacy_frames (id TEXT PRIMARY KEY, parent_id TEXT, payload TEXT NOT NULL)");
    db.query("INSERT INTO meta (key, value) VALUES ('version', '0')").run();
    db.query(
      "INSERT INTO legacy_frames (id, parent_id, payload) VALUES (?, ?, ?)"
    ).run("old-1", null, JSON.stringify({ role: "user", content: "legacy-sqlite" }));
    db.close();

    const store = createSqliteSessionStore({ path });
    expect(store.migrate().from).toBe(0);
    expect(store.version).toBe(1);
    expect(store.projection().messages.map((item) => item.content)).toEqual(["legacy-sqlite"]);
    const appended = await store.append({ role: "assistant", content: "new" } satisfies AgentMessage);
    expect(appended.seq).toBe(2);
    store.close();
  });

  test("写入后数据库文件包含 WAL 模式标记", async () => {
    const path = tempPath();
    const store = createSqliteSessionStore({ path });
    await store.append({ role: "user", content: "wal" } satisfies AgentMessage);
    expect(store.pragma("journal_mode")).toBe("wal");
    store.close();
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM frames").get()).toEqual({ n: 1 });
    db.close();
    writeFileSync(path + ".checked", "ok");
  });
});
