import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realmForSpace, type Principal } from "@zeta-agent/capabilities";
import { atomicWriteFileSync } from "@zeta-agent/security";
import { createFrameId, type SessionProjection } from "../session/store";

export const FROZEN_FORMAT = "zeta-frozen-evidence" as const;
export const FROZEN_VERSION = 1 as const;
/** 持久化 manifest 的 schema 版本；历史无版本字段按 1 只读兼容。 */
export const FROZEN_SCHEMA_VERSION = 1 as const;

export type ResearchMode = "live" | "replay";

/** 冻结产物的身份绑定：run/task/tenant/domain/mode + 租户 realm 缺一不可。 */
export interface EpisodeIdentity {
  readonly run: string;
  readonly task: string;
  readonly tenant: string;
  readonly domain: string;
  readonly mode: ResearchMode;
  readonly realm: symbol;
  /** 候选身份：同一 episode 下不同候选的证据按 candidate/digest 隔离。 */
  readonly candidate?: string;
}

export interface EpisodeIdentityInput {
  readonly run: string;
  readonly task: string;
  readonly tenant: string;
  readonly domain: string;
  readonly mode: ResearchMode;
  readonly principal?: Principal;
  readonly candidate?: string;
}

export function createEpisodeIdentity(input: EpisodeIdentityInput): EpisodeIdentity {
  if (input === null || typeof input !== "object") throw new Error("INVALID_IDENTITY");
  for (const field of ["run", "task", "tenant", "domain"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`INVALID_IDENTITY: ${field} required`);
    }
  }
  if (input.mode !== "live" && input.mode !== "replay") throw new Error("INVALID_IDENTITY: mode");
  if (input.candidate !== undefined && (typeof input.candidate !== "string" || input.candidate.length === 0)) {
    throw new Error("INVALID_IDENTITY: candidate");
  }
  return Object.freeze({
    run: input.run,
    task: input.task,
    tenant: input.tenant,
    domain: input.domain,
    mode: input.mode,
    realm: input.principal?.realm ?? realmForSpace(input.tenant),
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
  });
}

/** 稳定序列化：对象键排序，避免同一内容因键序产生不同地址。 */
export function stableEvidenceStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value instanceof Uint8Array) return JSON.stringify(`bytes:${value.length}`);
  if (Array.isArray(value)) return `[${value.map(stableEvidenceStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableEvidenceStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function identityDigest(identity: EpisodeIdentity): string {
  return createHash("sha256")
    .update(
      stableEvidenceStringify({
        run: identity.run,
        task: identity.task,
        tenant: identity.tenant,
        domain: identity.domain,
        mode: identity.mode,
        realm: String(identity.realm.description ?? ""),
        ...(identity.candidate === undefined ? {} : { candidate: identity.candidate }),
      })
    )
    .digest("hex");
}

export function contentDigest(value: string | Uint8Array): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("INVALID_EVIDENCE_CONTENT");
  return createHash("sha256").update(value).digest("hex");
}

/** 完整证据树：相对路径 → 全文，不做 prompt 截断或有损摘要。 */
export type EvidenceTree = Readonly<Record<string, string>>;

export interface EvidenceFiles {
  write(relativePath: string, content: string): void;
  read(relativePath: string): string;
  has(relativePath: string): boolean;
}

function assertEvidencePath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("EVIDENCE_PATH_INVALID");
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.split("/").includes(".")
  ) {
    throw new Error("EVIDENCE_PATH_UNSAFE");
  }
}

export function createMemoryEvidenceFiles(): EvidenceFiles {
  const stored = new Map<string, string>();
  return {
    write(relativePath, content) {
      assertEvidencePath(relativePath);
      stored.set(relativePath, content);
    },
    read(relativePath) {
      const value = stored.get(relativePath);
      if (value === undefined) throw new Error("EVIDENCE_FILE_NOT_FOUND");
      return value;
    },
    has(relativePath) {
      return stored.has(relativePath);
    },
  };
}

/** 文件适配器：证据全文落盘，prompt 只拿到路径指针。 */
export function createFileEvidenceFiles(rootDir: string): EvidenceFiles {
  if (typeof rootDir !== "string" || rootDir.length === 0) throw new Error("INVALID_EVIDENCE_ROOT");
  return {
    write(relativePath, content) {
      assertEvidencePath(relativePath);
      const target = join(rootDir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    },
    read(relativePath) {
      assertEvidencePath(relativePath);
      const target = join(rootDir, relativePath);
      if (!existsSync(target)) throw new Error("EVIDENCE_FILE_NOT_FOUND");
      return readFileSync(target, "utf8");
    },
    has(relativePath) {
      assertEvidencePath(relativePath);
      return existsSync(join(rootDir, relativePath));
    },
  };
}

/** 每个冻结产物按 candidate/digest 隔离的索引键。 */
export function frozenEntryKey(candidate: string | undefined, digest: string): string {
  return `${candidate === undefined || candidate.length === 0 ? "__none__" : candidate}/${digest}`;
}

export interface PersistedFrozenEntry {
  readonly key: string;
  readonly candidate: string | undefined;
  readonly digest: string;
  readonly frameId: string;
  readonly manifest: Record<string, unknown>;
  readonly evidence: Record<string, string>;
}

export interface PersistedFrozenManifest {
  /** 历史 manifest 可无此字段；读取时按 1 兼容，写入总是当前版本。 */
  readonly schemaVersion?: number;
  readonly entries: readonly PersistedFrozenEntry[];
}

export interface FrozenPersistence {
  load(): PersistedFrozenManifest | undefined;
  save(state: PersistedFrozenManifest): void;
}

/**
 * 文件持久化：manifest 索引以 atomicWriteFileSync 提交，条目按 candidate/digest 分目录落盘。
 * 重启后 load 还原全部快照与 evidence 全文，不依赖进程内存。
 */
export function createFileFrozenPersistence(rootDir: string): FrozenPersistence {
  if (typeof rootDir !== "string" || rootDir.length === 0) throw new Error("INVALID_FROZEN_ROOT");
  const manifestPath = join(rootDir, "manifest.json");
  return {
    load() {
      if (!existsSync(manifestPath)) return undefined;
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as PersistedFrozenManifest;
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
        throw new Error("FROZEN_MANIFEST_INVALID");
      }
      const version = parsed.schemaVersion ?? 1;
      if (version > FROZEN_SCHEMA_VERSION) throw new Error("FROZEN_SCHEMA_UNSUPPORTED");
      return { schemaVersion: version, entries: parsed.entries };
    },
    save(state) {
      mkdirSync(rootDir, { recursive: true });
      for (const entry of state.entries) {
        const directory = join(rootDir, "candidates", entry.key.split("/")[0]!);
        mkdirSync(directory, { recursive: true });
        atomicWriteFileSync(
          join(directory, `${entry.digest}.json`),
          stableEvidenceStringify(entry)
        );
      }
      atomicWriteFileSync(manifestPath, stableEvidenceStringify({
        ...state,
        schemaVersion: FROZEN_SCHEMA_VERSION,
      }));
    },
  };
}

/** T-11 SessionStore 的只读投影直接转成冻结证据文件，不复制会话实现。 */
export function evidenceFromSessionProjection(projection: SessionProjection): EvidenceTree {
  return Object.freeze({
    "session/messages.json": stableEvidenceStringify(projection.messages),
    "session/frames.json": stableEvidenceStringify(projection.frames),
    "session/lineage.json": stableEvidenceStringify(projection.lineage),
  });
}

export interface EvidenceFileRef {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface FrozenManifest {
  readonly format: typeof FROZEN_FORMAT;
  readonly version: typeof FROZEN_VERSION;
  readonly identity: EpisodeIdentity;
  readonly identityDigest: string;
  readonly generation: number;
  readonly files: readonly EvidenceFileRef[];
  readonly rootDigest: string;
  readonly createdAt: string;
  readonly digest: string;
}

export interface FrozenSnapshot {
  /** 复用 T-11 的不可变 frame id 语义。 */
  readonly frameId: string;
  readonly manifest: FrozenManifest;
  readonly evidence: EvidenceTree;
  readonly pointers: readonly string[];
}

export interface FrozenStoreOptions {
  readonly files?: EvidenceFiles;
  readonly now?: () => string;
  readonly generation?: () => number;
  /** 注入后 freeze 原子提交 manifest，构造时从 manifest 恢复（重启不丢证据）。 */
  readonly persistence?: FrozenPersistence;
}

export interface FrozenStore {
  readonly files: EvidenceFiles;
  freeze(identity: EpisodeIdentity, evidence: EvidenceTree, generation?: number): FrozenSnapshot;
  /** candidate 给定时只返回该候选的证据，避免跨候选串用。 */
  get(digest: string, candidate?: string): FrozenSnapshot | undefined;
  require(digest: string, candidate?: string): FrozenSnapshot;
  latest(identityDigest: string): FrozenSnapshot | undefined;
  manifests(): readonly FrozenManifest[];
}

function computeRootDigest(refs: readonly { readonly path: string; readonly digest: string }[]): string {
  const ordered = [...refs].sort((left, right) => left.path.localeCompare(right.path));
  return contentDigest(ordered.map((ref) => `${ref.path}\u0000${ref.digest}`).join("\n"));
}

type ContentAddressInput = Pick<
  FrozenManifest,
  "format" | "version" | "identityDigest" | "files" | "rootDigest"
>;

/** 内容地址只取内容字段；generation/createdAt 是谱系元数据，不参与寻址。 */
function computeContentAddress(manifest: ContentAddressInput): string {
  return contentDigest(
    stableEvidenceStringify({
      format: manifest.format,
      version: manifest.version,
      identityDigest: manifest.identityDigest,
      files: manifest.files,
      rootDigest: manifest.rootDigest,
    })
  );
}

export function assertFrozenImmutable(snapshot: FrozenSnapshot): true {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !Object.isFrozen(snapshot) ||
    !Object.isFrozen(snapshot.manifest) ||
    !Object.isFrozen(snapshot.evidence) ||
    !Object.isFrozen(snapshot.manifest.files) ||
    !Object.isFrozen(snapshot.pointers)
  ) {
    throw new Error("FROZEN_MUTATED");
  }
  const refs = Object.keys(snapshot.evidence)
    .sort()
    .map((path) => ({ path, digest: contentDigest(snapshot.evidence[path]!) }));
  if (computeRootDigest(refs) !== snapshot.manifest.rootDigest) throw new Error("FROZEN_MUTATED");
  if (computeContentAddress(snapshot.manifest) !== snapshot.manifest.digest) throw new Error("FROZEN_MUTATED");
  return true;
}

function serializeSnapshot(snapshot: FrozenSnapshot): PersistedFrozenEntry {
  const identity = snapshot.manifest.identity;
  return {
    key: frozenEntryKey(identity.candidate, snapshot.manifest.digest),
    candidate: identity.candidate,
    digest: snapshot.manifest.digest,
    frameId: snapshot.frameId,
    manifest: {
      ...snapshot.manifest,
      // realm 是 symbol，结构化 clone 会丢失；只保留可重建的描述并靠 identityDigest 校验。
      identity: { ...identity, realm: String(identity.realm.description ?? "") },
    },
    evidence: { ...snapshot.evidence },
  };
}

function deserializeSnapshot(entry: PersistedFrozenEntry, files: EvidenceFiles): FrozenSnapshot {
  const raw = entry.manifest?.identity as Record<string, unknown> | undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FROZEN_MANIFEST_INVALID");
  }
  const identity: EpisodeIdentity = Object.freeze({
    run: String(raw.run),
    task: String(raw.task),
    tenant: String(raw.tenant),
    domain: String(raw.domain),
    mode: raw.mode === "replay" ? "replay" : "live",
    realm: Symbol(String(raw.realm ?? "")),
    ...(typeof raw.candidate === "string" ? { candidate: raw.candidate } : {}),
  });
  const parsedFiles = (entry.manifest.files ?? []) as readonly EvidenceFileRef[];
  const filesRefs = Object.freeze(parsedFiles.map((ref) => Object.freeze({ ...ref })));
  const stored = entry.manifest as unknown as FrozenManifest;
  const manifest: FrozenManifest = Object.freeze({
    format: stored.format,
    version: stored.version,
    identity,
    identityDigest: stored.identityDigest,
    generation: stored.generation,
    files: filesRefs,
    rootDigest: stored.rootDigest,
    createdAt: stored.createdAt,
    digest: stored.digest,
  });
  if (manifest.identityDigest !== identityDigest(identity)) {
    throw new Error("FROZEN_MANIFEST_TAMPERED");
  }
  const evidence: Record<string, string> = {};
  for (const [path, content] of Object.entries(entry.evidence ?? {})) {
    if (typeof content !== "string") throw new Error("FROZEN_MANIFEST_INVALID");
    files.write(path, content);
    evidence[path] = content;
  }
  const snapshot: FrozenSnapshot = Object.freeze({
    frameId: entry.frameId,
    manifest,
    evidence: Object.freeze(evidence),
    pointers: Object.freeze(manifest.files.map((ref) => ref.path)),
  });
  assertFrozenImmutable(snapshot);
  return snapshot;
}

export function createFrozenStore(options: FrozenStoreOptions = {}): FrozenStore {
  const files = options.files ?? createMemoryEvidenceFiles();
  const now = options.now ?? (() => new Date().toISOString());
  let generationCounter = 0;
  const nextGeneration = options.generation ?? (() => {
    generationCounter += 1;
    return generationCounter;
  });
  const snapshots = new Map<string, FrozenSnapshot>();
  const byIdentity = new Map<string, FrozenSnapshot[]>();
  const persistence = options.persistence;

  const commit = (): void => {
    if (persistence === undefined) return;
    persistence.save({
      schemaVersion: FROZEN_SCHEMA_VERSION,
      entries: Object.freeze([...snapshots.values()].map(serializeSnapshot)),
    });
  };

  const restored = persistence?.load();
  if (restored !== undefined) {
    for (const entry of restored.entries) {
      const snapshot = deserializeSnapshot(entry, files);
      snapshots.set(snapshot.manifest.digest, snapshot);
      const lineage = byIdentity.get(snapshot.manifest.identityDigest) ?? [];
      lineage.push(snapshot);
      byIdentity.set(snapshot.manifest.identityDigest, lineage);
      generationCounter = Math.max(generationCounter, snapshot.manifest.generation);
    }
  }

  return {
    files,
    freeze(identity, evidence, generationOverride) {
      if (identity === null || typeof identity !== "object" || typeof identity.realm !== "symbol") {
        throw new Error("INVALID_IDENTITY");
      }
      if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
        throw new Error("INVALID_EVIDENCE_TREE");
      }
      const paths = Object.keys(evidence).sort();
      const refs: EvidenceFileRef[] = paths.map((path) => {
        assertEvidencePath(path);
        const content = evidence[path]!;
        if (typeof content !== "string") throw new Error("INVALID_EVIDENCE_CONTENT");
        files.write(path, content);
        return Object.freeze({
          path,
          digest: contentDigest(content),
          bytes: Buffer.byteLength(content, "utf8"),
        });
      });
      const rootDigest = computeRootDigest(refs);
      const addressInput: ContentAddressInput = {
        format: FROZEN_FORMAT,
        version: FROZEN_VERSION,
        identityDigest: identityDigest(identity),
        files: Object.freeze(refs),
        rootDigest,
      };
      const digest = computeContentAddress(addressInput);
      const existing = snapshots.get(digest);
      if (existing !== undefined) return existing;
      const generation = generationOverride ?? nextGeneration();
      if (!Number.isInteger(generation) || generation < 1) throw new Error("INVALID_GENERATION");
      const manifest: FrozenManifest = Object.freeze({
        ...addressInput,
        identity: Object.freeze({ ...identity }),
        generation,
        createdAt: now(),
        digest,
      });
      const snapshot: FrozenSnapshot = Object.freeze({
        frameId: createFrameId(),
        manifest,
        evidence: Object.freeze({ ...evidence }),
        pointers: Object.freeze(refs.map((ref) => ref.path)),
      });
      snapshots.set(digest, snapshot);
      const key = manifest.identityDigest;
      const lineage = byIdentity.get(key) ?? [];
      lineage.push(snapshot);
      byIdentity.set(key, lineage);
      commit();
      return snapshot;
    },
    get(digest, candidate) {
      const snapshot = snapshots.get(digest);
      if (snapshot === undefined) return undefined;
      if (candidate !== undefined && snapshot.manifest.identity.candidate !== candidate) return undefined;
      return snapshot;
    },
    require(digest, candidate) {
      const snapshot = this.get(digest, candidate);
      if (snapshot === undefined) throw new Error("FROZEN_NOT_FOUND");
      return snapshot;
    },
    latest(key) {
      const lineage = byIdentity.get(key);
      if (lineage === undefined || lineage.length === 0) return undefined;
      return lineage.reduce((best, item) =>
        item.manifest.generation > best.manifest.generation ? item : best
      );
    },
    manifests() {
      return Object.freeze([...snapshots.values()].map((item) => item.manifest));
    },
  };
}
