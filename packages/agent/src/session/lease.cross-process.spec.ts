import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlSessionStore } from "./jsonl-store";
import { createSqliteSessionStore } from "./sqlite-store";
import type { SessionStore } from "./store";

const dirs: string[] = [];
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lease-contender.mjs");

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows WAL 句柄释放可能稍晚；下一用例自然清理。
    }
  }
});

interface ChildResult {
  readonly ok: boolean;
  readonly code?: string;
}

async function contend(backend: "jsonl" | "sqlite", path: string, dir: string): Promise<ChildResult> {
  const resultPath = join(dir, `result-${backend}-${Math.random().toString(36).slice(2)}.json`);
  const child = Bun.spawn([process.execPath, fixture, backend, path, resultPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await child.exited;
  expect(code).toBe(0);
  expect(existsSync(resultPath)).toBe(true);
  return JSON.parse(readFileSync(resultPath, "utf8")) as ChildResult;
}

describe("T-17 跨进程 SessionStore 租约唯一 writer", () => {
  for (const backend of ["jsonl", "sqlite"] as const) {
    test(`${backend}：父进程持租约时子进程写入被拒，父进程释放后子进程可写`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `zeta-t17-cross-${backend}-`));
      dirs.push(dir);
      const path = join(dir, `session.${backend}`);
      const create = backend === "jsonl" ? createJsonlSessionStore : createSqliteSessionStore;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
      const parent: SessionStore = create({
        path,
        leaseOwner: "parent-process",
        faults: {
          afterLeaseAcquire: async () => {
            ready();
            await gate;
          },
        },
      });

      const pending = parent.append({ role: "user", content: "parent" });
      await readyPromise;
      const blocked = await contend(backend, path, dir);
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe("SESSION_LEASE_BUSY");

      release();
      await pending;
      const allowed = await contend(backend, path, dir);
      expect(allowed.ok).toBe(true);
      expect(parent.projection().messages.map((item) => item.content)).toContain("parent");
      parent.close();
    });
  }
});
