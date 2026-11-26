import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact";
import { computeConfigDigest } from "./canonical";
import { computeStableConfigDigest } from "./config-digest";
import {
  currentRelease,
  installRelease,
  readReleaseLog,
  stageRelease,
  type ReleaseStore,
} from "./lifecycle";

function manifest(target: ArtifactManifest["target"] = "linux-x64"): ArtifactManifest {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    version: 1,
    target,
    binary: {
      arch: target.includes("arm64") ? "arm64" : "x64",
      path: "zeta",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    embedded: [],
  };
}

class MemoryStore implements ReleaseStore {
  readonly files = new Map<string, string>();
  readonly renames: string[] = [];
  rename?: (from: string, to: string) => void;
  constructor(withRename = true) {
    if (withRename) {
      this.rename = (from, to) => {
        const value = this.files.get(from);
        if (value === undefined) throw new Error(`ENOENT ${from}`);
        this.files.delete(from);
        this.files.set(to, value);
        this.renames.push(`${from}->${to}`);
      };
    }
  }
  read(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }
  write(path: string, data: string): void {
    this.files.set(path, data);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
}

const root = "/deploy";
const always = { startup: () => true, readiness: () => true };

describe("T-24 staged release：原子切换、失败回滚与可复核日志", () => {
  test("digest/config 校验通过后原子切换 current，日志可复核", async () => {
    const store = new MemoryStore();
    installRelease(root, "1.0.0", manifest(), store);
    const next = manifest("linux-arm64");
    const result = await stageRelease(root, "2.0.0", next, store, {
      probe: always,
      expectedDigest: computeConfigDigest(next as unknown as Record<string, unknown>),
      expectedConfigDigest: computeStableConfigDigest({
        target: next.target,
        version: "2.0.0",
        digest: computeConfigDigest(next as unknown as Record<string, unknown>),
      }),
    });
    expect(result.from).toBe("1.0.0");
    expect(result.to).toBe("2.0.0");
    expect(result.rolledBack).toBe(false);
    expect(currentRelease(root, store).version).toBe("2.0.0");
    expect(store.renames.some((entry) => entry.includes("current.json.tmp->") && entry.endsWith("/current.json"))).toBe(true);
    const actions = readReleaseLog(store, root).map((event) => event.action);
    for (const action of ["stage", "verified", "probe", "switch"] as const) expect(actions).toContain(action);
  });

  test("摘要不匹配与启动探针失败都不切换 current", async () => {
    const store = new MemoryStore();
    installRelease(root, "1.0.0", manifest(), store);
    await expect(
      stageRelease(root, "2.0.0", manifest("linux-arm64"), store, {
        probe: always,
        expectedDigest: "wrong",
      })
    ).rejects.toThrow(/STAGED_DIGEST_MISMATCH/);
    expect(currentRelease(root, store).version).toBe("1.0.0");
    await expect(
      stageRelease(root, "2.0.0", manifest("linux-arm64"), store, {
        probe: { startup: () => false, readiness: () => true },
      })
    ).rejects.toThrow(/STAGED_STARTUP_FAILED/);
    expect(currentRelease(root, store).version).toBe("1.0.0");
  });

  test("提交后 readiness 不匹配自动恢复上一版并记录 rollback", async () => {
    const store = new MemoryStore();
    installRelease(root, "1.0.0", manifest(), store);
    let calls = 0;
    const result = await stageRelease(root, "2.0.0", manifest("linux-arm64"), store, {
      probe: {
        startup: () => true,
        readiness: () => {
          calls += 1;
          return calls !== 2;
        },
      },
    });
    expect(result.rolledBack).toBe(true);
    expect(currentRelease(root, store).version).toBe("1.0.0");
    expect(readReleaseLog(store, root).some((event) => event.action === "rollback")).toBe(true);
  });

  test("无原子 rename 能力的 store 失败关闭，不伪造原子发布", async () => {
    const store = new MemoryStore(false);
    installRelease(root, "1.0.0", manifest(), store);
    await expect(stageRelease(root, "2.0.0", manifest(), store, { probe: always })).rejects.toThrow(
      /ATOMIC_RENAME_REQUIRED/
    );
  });
});
