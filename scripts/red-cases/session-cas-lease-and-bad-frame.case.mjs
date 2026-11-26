/**
 * RED-13：SessionStore 恢复/崩溃并发的两个缺口（本地 fixture，不访问外网）。
 *
 * 子探针 A：坏 frame（坏行/截断行/未知 schemaVersion）必须强制 readonly/unknown，
 *           不得被静默跳过后再静默重写干净文件。
 * 子探针 B：租约必须 CAS：旧 writer 的迟到 release 不得删除接管 writer 的租约；
 *           两个 writer 通过 writerId 分区进程内锁模拟跨进程，只有文件/库租约裁决唯一写者。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createJsonlSessionStore } from "../../packages/agent/src/session/jsonl-store.ts";
import { createSqliteSessionStore } from "../../packages/agent/src/session/sqlite-store.ts";
import { green, red, text } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/session/jsonl-store.ts:parseJsonl/classify/recover、sqlite-store.ts:readFrames/state；" +
  "两后端 acquireLease/releaseLease 为 check-then-delete，非 CAS";

const M = {
  msg: (content) => ({ role: "user", content }),
};

function seedDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
}

function seedJsonlBadFrames(path) {
  const header = {
    type: "header",
    header: { format: "zeta-session-store", version: 1, sessionId: "red13-bad", createdAt: "bad" },
  };
  const good = { type: "frame", frame: { id: "good", seq: 1, parentId: null, createdAt: "bad", kind: "message", message: { role: "user", content: "good" } } };
  const unknownSchema = {
    type: "frame",
    frame: { id: "future", seq: 2, parentId: "good", createdAt: "bad", schemaVersion: 99, kind: "message", message: { role: "user", content: "future" } },
  };
  writeFileSync(path, [JSON.stringify(header), JSON.stringify(good), JSON.stringify(unknownSchema), '{"type":"frame","frame":{"id":"torn"\n', "not-json\n"].join("\n") + "\n");
}

function seedSqliteBadFrames(path) {
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE frames (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, parent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE pending (id TEXT PRIMARY KEY, frame_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inflight')");
    db.query("INSERT INTO meta (key, value) VALUES ('version', '1'), ('session_id', 'red13-bad'), ('created_at', 'bad')").run();
    const frame = { id: "good", seq: 1, parentId: null, createdAt: "bad", kind: "message", message: { role: "user", content: "good" } };
    db.query("INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("good", 1, null, "message", JSON.stringify(frame), "bad");
    const future = { ...frame, id: "future", seq: 2, parentId: "good", schemaVersion: 99 };
    db.query("INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("future", 2, "good", "message", JSON.stringify(future), "bad");
    db.query("INSERT INTO frames (id, seq, parent_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("torn", 3, "good", "message", "{broken", "bad");
  } finally {
    db.close();
  }
}

async function badFrameProbe(name, create, seed) {
  const dir = seedDir(`zeta-red13-bad-${name}-`);
  let store;
  try {
    const path = join(dir, `session.${name}`);
    seed(path);
    store = create({ path, sessionId: "red13-bad" });
    const before = store.projection().messages.map((message) => text(message.content));
    const state = store.state;
    const badLines = store.projection().badLines;
    let appendCode = "";
    try {
      await store.append(M.msg("must-be-blocked"));
    } catch (error) {
      appendCode = error instanceof Error && "code" in error ? String(error.code) : String(error);
    }
    const actual = { name, before, state, badLines, appendCode };
    const blocked = state === "readonly" || state === "unknown-outcome" || state === "unknown";
    return blocked && appendCode.length > 0 && badLines > 0
      ? { green: true, actual }
      : {
          green: false,
          actual,
          reason: `${name} 坏 frame 被静默跳过：state=${state} badLines=${badLines} append=${appendCode || "成功"}（应为 readonly/unknown 且拒绝写入）`,
        };
  } catch (error) {
    return { green: false, actual: { name }, reason: `bad-frame 探针异常：${String(error)}` };
  } finally {
    store?.close();
    await removeDir(dir);
  }
}

async function waitFor(predicate, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(5);
  }
  return predicate();
}

async function leaseCasProbe(name, create) {
  const dir = seedDir(`zeta-red13-lease-${name}-`);
  const stores = [];
  const appends = [];
  let releaseA;
  let releaseB;
  try {
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    const clock = { now: 1_000_000 };
    const shared = {
      path: join(dir, `session.${name}`),
      now: () => clock.now,
      leaseTtlMs: 100,
      retryMs: 30,
    };
    const flags = { a: false, b: false };

    const a = create({ ...shared, sessionId: "red13-a", leaseOwner: "writer-A", writerId: "A", faults: { afterLeaseAcquire: async () => { flags.a = true; await gateA; } } });
    const b = create({ ...shared, sessionId: "red13-b", leaseOwner: "writer-B", writerId: "B", faults: { afterLeaseAcquire: async () => { flags.b = true; await gateB; } } });
    const c = create({ ...shared, sessionId: "red13-c", leaseOwner: "writer-C", writerId: "C" });
    stores.push(a, b, c);

    const aAppend = a.append(M.msg("A"));
    appends.push(aAppend);
    if (!(await waitFor(() => flags.a && a.lease()?.owner === "writer-A", 1000))) {
      return { green: false, actual: { name, phase: "A 未在租约获取后暂停", aOwner: a.lease()?.owner }, reason: "租约获取后无 CAS 切点，无法形成可复现的跨 writer 交错" };
    }

    // A 的租约过期；B 作为另一个 writer 合法接管（跨进程语义由 writerId 分区进程内锁模拟）。
    clock.now += 101;
    const bAppend = b.append(M.msg("B"));
    appends.push(bAppend);
    const bTookOver = await waitFor(() => flags.b && b.lease()?.owner === "writer-B", 1000);
    if (!bTookOver) {
      return {
        green: false,
        actual: { name, phase: "B 未接管", aOwner: a.lease()?.owner, bOwner: b.lease()?.owner },
        reason: `${name} 另 writer 无法在旧租约过期后接管：进程内锁未按 writer 分区或租约非 CAS`,
      };
    }

    // A 迟到完成；其 release 不得删除 B 当前持有的租约。
    releaseA?.();
    await aAppend;
    const bStillOwner = b.lease()?.owner === "writer-B";
    let cCode = "";
    try {
      await c.append(M.msg("C"));
    } catch (error) {
      cCode = error instanceof Error && "code" in error ? String(error.code) : String(error);
    }
    releaseB?.();
    await bAppend;

    const actual = { name, bOwnerAfterLateRelease: b.lease()?.owner, cCode, bStillOwner };
    return bStillOwner && cCode === "SESSION_LEASE_BUSY"
      ? { green: true, actual }
      : {
          green: false,
          actual,
          reason: `${name} 租约非 CAS：旧 writer 迟到 release 删除了接管者租约（cCode=${cCode || "成功"}，应为 SESSION_LEASE_BUSY）`,
        };
  } catch (error) {
    return { green: false, actual: { name }, reason: `lease-CAS 探针异常：${String(error)}` };
  } finally {
    releaseA?.();
    releaseB?.();
    await Promise.allSettled(appends);
    for (const store of stores) store.close();
    await removeDir(dir);
  }
}

export default {
  id: "RED-13-session-cas-lease-and-bad-frame",
  title: "SessionStore 坏 frame 只读 + 租约 CAS 唯一 writer",
  expectation:
    "JSONL/SQLite 坏 frame 强制 readonly/unknown 且拒绝写入；旧 writer 迟到 release 不得删除接管 writer 的租约，第三 writer 必须 SESSION_LEASE_BUSY",
  target: "AC-17 / NFR-03",
  async probe() {
    const results = [
      await badFrameProbe("jsonl", createJsonlSessionStore, seedJsonlBadFrames),
      await badFrameProbe("sqlite", createSqliteSessionStore, seedSqliteBadFrames),
      await leaseCasProbe("jsonl", createJsonlSessionStore),
      await leaseCasProbe("sqlite", createSqliteSessionStore),
    ];
    const actual = results.map((result) => result.actual);
    const failed = results.filter((result) => !result.green);
    return failed.length === 0
      ? green(actual, "双后端坏 frame readonly + 租约 CAS 唯一 writer")
      : red(
          actual,
          failed.map((result) => result.reason).join("；"),
          EVIDENCE
        );
  },
};
