import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realmForSpace, type Principal } from "@zeta-agent/capabilities";
import { createFrameId, type SessionProjection } from "../session/store";

export const FROZEN_FORMAT = "zeta-frozen-evidence" as const;
export const FROZEN_VERSION = 1 as const;

export type ResearchMode = "live" | "replay";

/** 冻结产物的身份绑定：run/task/tenant/domain/mode + 租户 realm 缺一不可。 */
export interface EpisodeIdentity {
  readonly run: string;
  readonly task: string;
  readonly tenant: string;
  readonly domain: string;
  readonly mode: ResearchMode;
  readonly realm: symbol;
}

export interface EpisodeIdentityInput {
  readonly run: string;
  readonly task: string;
  readonly tenant: string;
  readonly domain: string;
  readonly mode: ResearchMode;
  readonly principal?: Principal;
}

export function createEpisodeIdentity(input: EpisodeIdentityInput): EpisodeIdentity {
  if (input === null || typeof input !== "object") throw new Error("INVALID_IDENTITY");
  for (const field of ["run", "task", "tenant", "domain"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`INVALID_IDENTITY: ${field} required`);
    }
  }
  if (input.mode !== "live" && input.mode !== "replay") throw new Error("INVALID_IDENTITY: mode");
  return Object.freeze({
    run: input.run,
    task: input.task,
    tenant: input.tenant,
    domain: input.domain,
    mode: input.mode,
    realm: input.principal?.realm ?? realmForSpace(input.tenant),
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
}

export interface FrozenStore {
  readonly files: EvidenceFiles;
  freeze(identity: EpisodeIdentity, evidence: EvidenceTree, generation?: number): FrozenSnapshot;
  get(digest: string): FrozenSnapshot | undefined;
  require(digest: string): FrozenSnapshot;
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
      return snapshot;
    },
    get(digest) {
      return snapshots.get(digest);
    },
    require(digest) {
      const snapshot = snapshots.get(digest);
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
