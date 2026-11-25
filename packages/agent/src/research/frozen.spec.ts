import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realmForSpace } from "@zeta-agent/capabilities";
import { listAssembly } from "../facade";
import {
  assertFrozenImmutable,
  contentDigest,
  createEpisodeIdentity,
  createFileEvidenceFiles,
  createFrozenStore,
  createMemoryEvidenceFiles,
  evidenceFromSessionProjection,
  FROZEN_FORMAT,
  identityDigest,
  type EpisodeIdentity,
  type EvidenceTree,
} from "./frozen";

function identity(overrides: Partial<EpisodeIdentity> = {}): EpisodeIdentity {
  return createEpisodeIdentity({
    run: "run-1",
    task: "task-1",
    tenant: "tenant-a",
    domain: "coding",
    mode: "live",
    ...overrides,
  });
}

function evidence(overrides: Partial<EvidenceTree> = {}): EvidenceTree {
  return {
    "rollout.md": "full trace without truncation\n".repeat(40),
    "candidate.ts": "export const next = 1 + 1;\n",
    ...overrides,
  };
}

describe("T-24 FrozenStore 身份绑定与内容寻址", () => {
  test("身份摘要覆盖 run/task/tenant/domain/mode/realm，逐字段变更都改变摘要", () => {
    const base = identity();
    const digest = identityDigest(base);
    expect(digest).toBe(identityDigest(identity()));

    expect(identityDigest(identity({ run: "run-2" }))).not.toBe(digest);
    expect(identityDigest(identity({ task: "task-2" }))).not.toBe(digest);
    expect(identityDigest(identity({ tenant: "tenant-b" }))).not.toBe(digest);
    expect(identityDigest(identity({ domain: "writing" }))).not.toBe(digest);
    expect(identityDigest(identity({ mode: "replay" }))).not.toBe(digest);
    expect(identityDigest(identity({ tenant: "tenant-b" }))).toBe(
      identityDigest(createEpisodeIdentity({
        run: "run-1",
        task: "task-1",
        tenant: "tenant-b",
        domain: "coding",
        mode: "live",
        principal: { userId: "u", spaceId: "tenant-b", realm: realmForSpace("tenant-b") },
      }))
    );
  });

  test("身份字段缺失或非字符串时抛错", () => {
    expect(() =>
      createEpisodeIdentity({
        run: "",
        task: "t",
        tenant: "s",
        domain: "d",
        mode: "live",
      })
    ).toThrow(/IDENTITY/);
    expect(() =>
      createEpisodeIdentity({
        run: "r",
        task: "t",
        tenant: "s",
        domain: "d",
        mode: "unknown" as "live",
      })
    ).toThrow(/IDENTITY/);
  });
});

describe("T-24 冻结 trace：manifest / 内容寻址 / 完整 evidence-as-files", () => {
  test("freeze 写入完整证据文件，manifest 记录逐文件摘要与指针", () => {
    const files = createMemoryEvidenceFiles();
    const store = createFrozenStore({ files });
    const tree = evidence();
    const snapshot = store.freeze(identity(), tree);

    expect(snapshot.manifest.format).toBe(FROZEN_FORMAT);
    expect(snapshot.manifest.identityDigest).toBe(identityDigest(identity()));
    expect(snapshot.manifest.files).toHaveLength(2);
    for (const ref of snapshot.manifest.files) {
      expect(ref.digest).toBe(contentDigest(tree[ref.path]!));
      expect(ref.bytes).toBe(Buffer.byteLength(tree[ref.path]!, "utf8"));
      expect(files.has(ref.path)).toBe(true);
      expect(files.read(ref.path)).toBe(tree[ref.path]!);
    }
    expect(snapshot.pointers).toContain("rollout.md");
    expect(files.read("rollout.md")).toHaveLength(tree["rollout.md"]!.length);
  });

  test("内容寻址：同内容同地址，任一字节变化产生新地址", () => {
    const store = createFrozenStore({ files: createMemoryEvidenceFiles() });
    const first = store.freeze(identity(), evidence());
    const again = store.freeze(identity(), evidence());
    const changed = store.freeze(identity(), evidence({ "candidate.ts": "export const next = 2;\n" }));

    expect(again.manifest.digest).toBe(first.manifest.digest);
    expect(again.manifest.rootDigest).toBe(first.manifest.rootDigest);
    expect(changed.manifest.digest).not.toBe(first.manifest.digest);
    expect(store.get(first.manifest.digest)).toBe(first);
    expect(store.require(changed.manifest.digest)).toBe(changed);
    expect(() => store.require("0".repeat(64))).toThrow(/FROZEN_NOT_FOUND/);
  });

  test("generation 单调递增，latest 按身份返回最高代次", () => {
    const store = createFrozenStore({ files: createMemoryEvidenceFiles() });
    const g1 = store.freeze(identity(), evidence());
    const g2 = store.freeze(identity(), evidence({ "candidate.ts": "export const next = 3;\n" }));
    expect(g2.manifest.generation).toBeGreaterThan(g1.manifest.generation);
    expect(store.latest(identityDigest(identity()))?.manifest.digest).toBe(g2.manifest.digest);
    expect(store.latest("0".repeat(64))).toBeUndefined();
  });

  test("冻结快照不可变：对象被冻结且篡改后 assert 抛错", () => {
    const files = createMemoryEvidenceFiles();
    const store = createFrozenStore({ files });
    const snapshot = store.freeze(identity(), evidence());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    expect(assertFrozenImmutable(snapshot)).toBe(true);
    expect(() => {
      (snapshot.evidence as Record<string, string>)["rollout.md"] = "tampered";
    }).toThrow();
    expect(() => assertFrozenImmutable({ ...snapshot, evidence: { ...snapshot.evidence, "rollout.md": "tampered" } })).toThrow(
      /FROZEN_MUTATED/
    );
    expect(files.read("rollout.md")).toContain("full trace");
  });

  test("证据相对路径必须安全，拒绝越界与绝对路径", () => {
    const store = createFrozenStore({ files: createMemoryEvidenceFiles() });
    expect(() => store.freeze(identity(), { "../secret.txt": "x" })).toThrow(/EVIDENCE_PATH/);
    expect(() => store.freeze(identity(), { "/tmp/secret.txt": "x" })).toThrow(/EVIDENCE_PATH/);
  });
});

describe("T-24 evidence-as-files 与 T-11 会话投影复用", () => {
  test("文件适配器把完整证据落盘，manifest 路径指针可回读", () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-frozen-"));
    try {
      const files = createFileEvidenceFiles(root);
      const store = createFrozenStore({ files });
      const tree = evidence();
      const snapshot = store.freeze(identity(), tree);
      for (const ref of snapshot.manifest.files) {
        expect(readFileSync(join(root, ref.path), "utf8")).toBe(tree[ref.path]!);
        expect(files.read(ref.path)).toBe(tree[ref.path]!);
      }
      expect(readFileSync(join(root, "rollout.md"), "utf8")).toContain("full trace");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SessionStore 投影直接转为冻结证据文件，不复制会话实现", () => {
    const files = createMemoryEvidenceFiles();
    const store = createFrozenStore({ files });
    const tree = evidenceFromSessionProjection({
      frames: [],
      branch: [],
      messages: [],
      lineage: [],
      markers: [],
      leafId: null,
      badLines: 0,
    });
    const snapshot = store.freeze(identity(), tree);
    expect(snapshot.pointers).toContain("session/messages.json");
    expect(snapshot.pointers).toContain("session/frames.json");
    for (const ref of snapshot.manifest.files) {
      expect(files.read(ref.path)).toBe(tree[ref.path]!);
    }
  });
});

describe("T-24 研究轨不进入默认装配", () => {
  test("默认装配清单不含 frozen/decision/surface/replay", () => {
    for (const id of listAssembly()) {
      expect(id).not.toMatch(/frozen|decision|surface|replay|research/i);
    }
  });
});
