import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

export interface AuditRecord {
  readonly ts: number;
  readonly actor: string;
  readonly tenant: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly decision: string;
  readonly resultDigest: string;
  readonly causalId: string;
}

export interface AuditEntry {
  readonly seq: number;
  readonly record: AuditRecord;
  readonly prevHash: string;
  readonly hash: string;
}

export type FinalizedState = "complete" | "complete-with-drops" | "incomplete";

export type HashFn = (input: string) => string;

export type AuditSigner = (payload: string) => string;

/** 进程外 append-only 存储：只有追加与读取，签名和封存标记由 sink 注入。 */
export interface AuditStorage {
  append(line: string): void;
  readLines(): readonly string[];
  writeMarker(revision: number, marker: string): void;
  readMarker(revision: number): string | undefined;
}

export interface AuditSink {
  readonly entries: readonly AuditEntry[];
  append(record: AuditRecord): AuditEntry;
  noteDrop(): void;
  finalized(revision: number): FinalizedState;
}

export interface AuditSinkOptions {
  readonly hash?: HashFn;
  /** 显式注入才落盘；默认仍为内存实现。 */
  readonly storage?: AuditStorage;
  readonly sign?: AuditSigner;
}

export interface AuditIntegrityResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly entries: number;
  readonly finalized?: FinalizedState;
}

interface StoredAuditLine {
  readonly entry: AuditEntry;
  readonly signature: string;
}

interface StoredFinalizedMarker {
  readonly schema: "zeta-audit-signed/v1";
  readonly revision: number;
  readonly finalized: FinalizedState;
  readonly seq: number;
  readonly head: string;
  readonly digest: string;
  readonly signature: string;
}

function defaultHash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
}

function fingerprint(seq: number, prevHash: string, record: AuditRecord): string {
  return `${seq}|${prevHash}|${JSON.stringify(record)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!isRecord(value)) return false;
  if (typeof value.seq !== "number" || typeof value.prevHash !== "string" || typeof value.hash !== "string") return false;
  return isRecord(value.record) && typeof value.record.ts === "number" && typeof value.record.toolName === "string";
}

function entrySignaturePayload(entry: AuditEntry): string {
  return `entry|${fingerprint(entry.seq, entry.prevHash, entry.record)}|${entry.hash}`;
}

function finalSignaturePayload(revision: number, digest: string, finalized: FinalizedState, seq: number): string {
  return `final|${revision}|${seq}|${digest}|${finalized}`;
}

function chainDigest(hash: HashFn, entries: readonly AuditEntry[]): string {
  return hash(entries.map((entry) => entry.hash).join("|"));
}

export function createHmacAuditSigner(secret: string): AuditSigner {
  if (typeof secret !== "string" || secret.length === 0) throw new Error("INVALID_SIGNING_SECRET");
  return (payload) => createHmac("sha256", secret).update(payload).digest("hex");
}

/** 文件存储：审计行只能追加，finalized 标记按 revision 单独落文件。 */
export function createFileAuditStorage(dir: string): AuditStorage {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("INVALID_AUDIT_DIR");
  const logPath = join(dir, "audit-append.log");
  const markerPath = (revision: number): string => join(dir, `audit-final-${revision}.json`);
  return {
    append(line) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(logPath, `${line}\n`, "utf8");
    },
    readLines() {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    },
    writeMarker(revision, marker) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(markerPath(revision), marker, "utf8");
    },
    readMarker(revision) {
      const path = markerPath(revision);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
  };
}

export function verifyAuditChain(entries: readonly AuditEntry[], hash: HashFn): boolean {
  let previous = "0";
  let expectedSeq = 0;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) return false;
    if (entry.prevHash !== previous) return false;
    if (entry.hash !== hash(fingerprint(entry.seq, entry.prevHash, entry.record))) return false;
    previous = entry.hash;
    expectedSeq += 1;
  }
  return true;
}

/** 重新读取进程外存储，逐条校验 hash 链 + 签名，并核对 finalized 封存标记。 */
export function verifyAuditIntegrity(options: {
  readonly storage: AuditStorage;
  readonly hash: HashFn;
  readonly sign: AuditSigner;
  readonly revision: number;
}): AuditIntegrityResult {
  const { storage, hash, sign, revision } = options;
  const lines = storage.readLines();
  const entries: AuditEntry[] = [];
  let previous = "0";
  for (let index = 0; index < lines.length; index += 1) {
    let stored: StoredAuditLine;
    try {
      stored = JSON.parse(lines[index]!) as StoredAuditLine;
    } catch {
      return { ok: false, reason: `INVALID_LINE:${index}`, entries: lines.length };
    }
    const entry = stored.entry;
    if (!isAuditEntry(entry)) return { ok: false, reason: `INVALID_ENTRY:${index}`, entries: lines.length };
    if (entry.seq !== index || entry.prevHash !== previous) {
      return { ok: false, reason: `CHAIN_BREAK:${index}`, entries: lines.length };
    }
    if (entry.hash !== hash(fingerprint(entry.seq, entry.prevHash, entry.record))) {
      return { ok: false, reason: `HASH_MISMATCH:${index}`, entries: lines.length };
    }
    if (stored.signature !== sign(entrySignaturePayload(entry))) {
      return { ok: false, reason: `SIGNATURE_MISMATCH:${index}`, entries: lines.length };
    }
    entries.push(entry);
    previous = entry.hash;
  }

  const markerText = storage.readMarker(revision);
  if (markerText === undefined) return { ok: false, reason: "MISSING_FINALIZED_MARKER", entries: entries.length };
  let marker: StoredFinalizedMarker;
  try {
    marker = JSON.parse(markerText) as StoredFinalizedMarker;
  } catch {
    return { ok: false, reason: "INVALID_FINALIZED_MARKER", entries: entries.length };
  }
  const digest = chainDigest(hash, entries);
  if (
    marker.digest !== digest ||
    marker.seq !== entries.length ||
    marker.signature !== sign(finalSignaturePayload(revision, digest, marker.finalized, entries.length))
  ) {
    return { ok: false, reason: "FINALIZED_MISMATCH", entries: entries.length };
  }
  return { ok: true, entries: entries.length, finalized: marker.finalized };
}

export function createAuditSink(options: AuditSinkOptions = {}): AuditSink {
  const hash = options.hash ?? defaultHash;
  const storage = options.storage;
  const sign = options.sign;
  const entries: AuditEntry[] = [];
  let drops = 0;

  return {
    get entries(): readonly AuditEntry[] {
      // 只暴露快照，外部改动不能影响内部链。
      return entries.map((entry) => ({ ...entry, record: { ...entry.record } }));
    },
    append(record: AuditRecord): AuditEntry {
      const seq = entries.length;
      const prevHash = seq === 0 ? "0" : entries[seq - 1]!.hash;
      const snapshot: AuditRecord = { ...record };
      const entry: AuditEntry = {
        seq,
        record: snapshot,
        prevHash,
        hash: hash(fingerprint(seq, prevHash, snapshot)),
      };
      entries.push(entry);
      if (storage !== undefined) {
        const stored: StoredAuditLine = {
          entry,
          signature: sign === undefined ? "" : sign(entrySignaturePayload(entry)),
        };
        storage.append(JSON.stringify(stored));
      }
      return { ...entry, record: { ...snapshot } };
    },
    noteDrop(): void {
      drops += 1;
    },
    finalized(revision: number): FinalizedState {
      if (!Number.isInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
      if (revision > entries.length) return "incomplete";
      const finalized: FinalizedState = drops > 0 ? "complete-with-drops" : "complete";
      if (storage !== undefined) {
        const digest = chainDigest(hash, entries);
        const marker: StoredFinalizedMarker = {
          schema: "zeta-audit-signed/v1",
          revision,
          finalized,
          seq: entries.length,
          head: entries.length > 0 ? entries[entries.length - 1]!.hash : "0",
          digest,
          signature: sign === undefined ? "" : sign(finalSignaturePayload(revision, digest, finalized, entries.length)),
        };
        storage.writeMarker(revision, JSON.stringify(marker));
      }
      return finalized;
    },
  };
}
