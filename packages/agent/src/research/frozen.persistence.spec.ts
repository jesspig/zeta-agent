import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFrozenImmutable,
  createEpisodeIdentity,
  createFileEvidenceFiles,
  createFileFrozenPersistence,
  createFrozenStore,
  frozenEntryKey,
  FROZEN_SCHEMA_VERSION,
  type EpisodeIdentity,
  type EvidenceTree,
} from "./frozen";

function identity(candidate?: string): EpisodeIdentity {
  return createEpisodeIdentity({
    run: "run-p",
    task: "task-p",
    tenant: "tenant-p",
    domain: "coding",
    mode: "live",
    ...(candidate === undefined ? {} : { candidate }),
  });
}

function evidence(marker: string): EvidenceTree {
  return {
    "rollout.md": `full raw trace ${marker}\n`.repeat(20),
    "candidate.ts": `export const marker = ${JSON.stringify(marker)};\n`,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "zeta-frozen-persist-"));
}

describe("T-22 FrozenStore 按 candidate/digest 隔离与重启恢复", () => {
  test("同 episode 不同候选产生不同 digest，get(digest, candidate) 不串用", () => {
    const root = tempRoot();
    try {
      const persistence = createFileFrozenPersistence(join(root, "evidence"));
      const store = createFrozenStore({
        files: createFileEvidenceFiles(join(root, "evidence", "files")),
        persistence,
      });
      const left = store.freeze(identity("cand-a"), evidence("a"));
      const right = store.freeze(identity("cand-b"), evidence("b"));

      expect(left.manifest.digest).not.toBe(right.manifest.digest);
      expect(store.get(left.manifest.digest, "cand-a")).toBe(left);
      expect(store.get(left.manifest.digest, "cand-b")).toBeUndefined();
      expect(store.get(right.manifest.digest, "cand-b")).toBe(right);
      expect(() => store.require(left.manifest.digest, "cand-b")).toThrow(/FROZEN_NOT_FOUND/);
      expect(frozenEntryKey("cand-a", left.manifest.digest)).toBe(`cand-a/${left.manifest.digest}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest 以 schemaVersion 原子提交，条目按 candidate/digest 分目录", () => {
    const root = tempRoot();
    try {
      const persistence = createFileFrozenPersistence(root);
      const store = createFrozenStore({ persistence });
      const snapshot = store.freeze(identity("cand-c"), evidence("c"));
      const manifestPath = join(root, "manifest.json");
      const persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(persisted.schemaVersion).toBe(FROZEN_SCHEMA_VERSION);
      expect(persisted.entries).toHaveLength(1);
      expect(persisted.entries[0].key).toBe(`cand-c/${snapshot.manifest.digest}`);
      expect(
        readFileSync(join(root, "candidates", "cand-c", `${snapshot.manifest.digest}.json`), "utf8")
      ).toContain("full raw trace c");
      expect(readFileSync(manifestPath, "utf8")).not.toContain(".zeta-tmp-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("新建 store 从 manifest 重启恢复：快照、evidence 全文、generation 与谱系都保留", () => {
    const root = tempRoot();
    try {
      const first = createFrozenStore({
        persistence: createFileFrozenPersistence(root),
        files: createFileEvidenceFiles(join(root, "files")),
      });
      const a = first.freeze(identity("cand-a"), evidence("round-1"));
      const b = first.freeze(identity("cand-a"), evidence("round-2"));

      const restored = createFrozenStore({
        persistence: createFileFrozenPersistence(root),
        files: createFileEvidenceFiles(join(root, "files")),
      });
      expect(restored.get(a.manifest.digest, "cand-a")?.evidence["rollout.md"]).toBe(
        a.evidence["rollout.md"]
      );
      expect(restored.get(b.manifest.digest, "cand-a")?.evidence["candidate.ts"]).toBe(
        b.evidence["candidate.ts"]
      );
      expect(assertFrozenImmutable(restored.require(b.manifest.digest, "cand-a"))).toBe(true);
      expect(restored.latest(a.manifest.identityDigest)?.manifest.digest).toBe(b.manifest.digest);
      const next = restored.freeze(identity("cand-a"), evidence("round-3"));
      expect(next.manifest.generation).toBeGreaterThan(b.manifest.generation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("schemaVersion 只读兼容历史 manifest（无版本字段按 1），高版本拒绝", () => {
    const root = tempRoot();
    try {
      const persistence = createFileFrozenPersistence(root);
      const store = createFrozenStore({ persistence });
      const snapshot = store.freeze(identity("legacy"), evidence("legacy"));
      const manifestPath = join(root, "manifest.json");
      const persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete persisted.schemaVersion;
      writeFileSync(manifestPath, JSON.stringify(persisted), "utf8");

      const restored = createFrozenStore({
        persistence: createFileFrozenPersistence(root),
      });
      expect(restored.get(snapshot.manifest.digest, "legacy")).toBeDefined();

      persisted.schemaVersion = FROZEN_SCHEMA_VERSION + 1;
      writeFileSync(manifestPath, JSON.stringify(persisted), "utf8");
      expect(() =>
        createFrozenStore({ persistence: createFileFrozenPersistence(root) })
      ).toThrow(/FROZEN_SCHEMA_UNSUPPORTED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("历史 manifest 的 identityDigest 被篡改时拒绝恢复", () => {
    const root = tempRoot();
    try {
      const persistence = createFileFrozenPersistence(root);
      const store = createFrozenStore({ persistence });
      const snapshot = store.freeze(identity("tamper"), evidence("tamper"));
      const manifestPath = join(root, "manifest.json");
      const persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
      persisted.entries[0].manifest.identityDigest = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(persisted), "utf8");
      expect(() =>
        createFrozenStore({ persistence: createFileFrozenPersistence(root) })
      ).toThrow(/FROZEN_MANIFEST_TAMPERED/);
      expect(snapshot.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
