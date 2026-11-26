import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, migrateSessionJsonl } from "./jsonl-store";
import type { AgentMessage } from "@zeta-agent/agent-framework";
import { runSessionStoreConformance, type ConformanceFactoryOptions } from "./store.conformance.spec";
import { SESSION_STORE_FORMAT, SESSION_STORE_VERSION } from "./store";

const dirs: string[] = [];
function tempPath(name = "session.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-jsonl-store-"));
  dirs.push(dir);
  return join(dir, name);
}
function clonePath(primary: string): string {
  return join(primary, "..", "clone.jsonl");
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

let primaryPath: string | undefined;
beforeEach(() => {
  primaryPath = undefined;
});
function create(options?: ConformanceFactoryOptions) {
  primaryPath ??= tempPath();
  return createJsonlSessionStore({
    path: options?.destination ?? primaryPath,
    sessionId: options?.sessionId,
    faults: options?.faults,
    writerId: options?.writerId,
    leaseOwner: options?.leaseOwner,
    leaseTtlMs: options?.leaseTtlMs,
    retryMs: options?.retryMs,
    now: options?.now,
  });
}
const factory = Object.assign(create, {
  destination: () => join(primaryPath ?? tempPath(), "..", "clone.jsonl"),
  seedBadFrame: () => {
    const path = primaryPath ?? tempPath();
    appendFileSync(path, '{"type":"frame","frame":{"id":"torn"\n');
    appendFileSync(path, "not-json\n");
  },
});

runSessionStoreConformance("JSONL", factory);

describe("T-11 JSONL SessionStore 专项", () => {
  test("坏行/截断行/未知 schemaVersion 强制 readonly，不被静默跳过或重写", async () => {
    const path = tempPath();
    const store = createJsonlSessionStore({ path, sessionId: "bad-lines" });
    await store.append({ role: "user", content: "good" } satisfies AgentMessage);
    appendFileSync(path, '{"type":"frame","frame":{"id":"torn"\n');
    appendFileSync(path, "this-is-not-json\n");
    appendFileSync(
      path,
      JSON.stringify({
        type: "frame",
        frame: {
          id: "future",
          seq: 2,
          parentId: null,
          createdAt: "future",
          schemaVersion: SESSION_STORE_VERSION + 1,
          kind: "message",
          message: { role: "user", content: "future" },
        },
      }) + "\n"
    );
    const raw = readFileSync(path, "utf8");

    const reopened = createJsonlSessionStore({ path });
    expect(reopened.state).toBe("readonly");
    expect(reopened.projection().badLines).toBe(3);
    expect(reopened.projection().messages.map((item) => item.content)).toEqual(["good"]);
    await expect(reopened.append({ role: "user", content: "blocked" })).rejects.toMatchObject({
      code: "SESSION_READONLY",
    });
    expect(() => reopened.migrate()).toThrow("坏 frame");

    const recovery = await reopened.recover();
    expect(recovery.badLines).toBe(3);
    expect(recovery.state).toBe("readonly");
    // recover 不得静默丢弃坏 frame：原始字节保持完整，unknown 只对 pending 生效。
    expect(readFileSync(path, "utf8")).toBe(raw);

    store.close();
    reopened.close();
  });

  test("v0 旧格式自动迁移到 v1，追加与重开均可用", async () => {
    const path = tempPath();
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "header",
          header: { format: SESSION_STORE_FORMAT, version: 0, sessionId: "legacy", createdAt: "old" },
        }),
        JSON.stringify({
          id: "legacy-1",
          parentId: null,
          kind: "message",
          message: { role: "user", content: "legacy-message" },
        }),
      ].join("\n") + "\n"
    );
    const store = createJsonlSessionStore({ path });
    expect(store.version).toBe(SESSION_STORE_VERSION);
    expect(store.migrate().from).toBe(0);
    expect(store.projection().messages.map((item) => item.content)).toEqual(["legacy-message"]);
    const appended = await store.append({ role: "assistant", content: "new" });
    expect(appended.seq).toBe(2);
    const reopened = createJsonlSessionStore({ path });
    expect(reopened.projection().messages.map((item) => item.content)).toEqual([
      "legacy-message",
      "new",
    ]);
    store.close();
    reopened.close();
  });

  test("migrateSessionJsonl 纯函数补齐 header 与 frame 字段", () => {
    const legacy = [
      JSON.stringify({ id: "a", parentId: null, kind: "message", message: { role: "user", content: "x" } }),
      "",
    ].join("\n");
    const migrated = migrateSessionJsonl(legacy, "migrated-session");
    expect(migrated.header.version).toBe(SESSION_STORE_VERSION);
    expect(migrated.header.sessionId).toBe("migrated-session");
    expect(migrated.frames[0]?.seq).toBe(1);
    expect(typeof migrated.frames[0]?.createdAt).toBe("string");
  });

  test("未来版本保持只读且不改写文件", async () => {
    const path = tempPath();
    const raw = JSON.stringify({
      type: "header",
      header: {
        format: SESSION_STORE_FORMAT,
        version: SESSION_STORE_VERSION + 99,
        sessionId: "future",
        createdAt: "future",
      },
    }) + "\n";
    writeFileSync(path, raw);
    const store = createJsonlSessionStore({ path });
    expect(store.state).toBe("readonly");
    await expect(store.append({ role: "user", content: "blocked" })).rejects.toMatchObject({
      code: "SESSION_READONLY",
    });
    expect(readFileSync(path, "utf8")).toBe(raw);
    store.close();
  });

  test("租约在写入期间可见，释放后再次可写", async () => {
    const path = tempPath();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createJsonlSessionStore({
      path,
      leaseOwner: "owner-a",
      faults: {
        beforeCommit: async () => {
          await gate;
        },
      },
    });
    const pending = store.append({ role: "user", content: "leased" });
    await Bun.sleep(0);
    expect(existsSync(`${path}.lease`)).toBe(true);
    expect(store.lease()?.owner).toBe("owner-a");
    release?.();
    await pending;
    expect(existsSync(`${path}.lease`)).toBe(false);
    expect(store.lease()).toBeUndefined();
    store.close();
  });

  test("clonePath 助手生成与 conformance 一致的独立路径", () => {
    const path = tempPath();
    expect(clonePath(path)).toContain("clone.jsonl");
  });
});
