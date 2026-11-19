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

export interface AuditSink {
  readonly entries: readonly AuditEntry[];
  append(record: AuditRecord): AuditEntry;
  noteDrop(): void;
  finalized(revision: number): FinalizedState;
}

export interface AuditSinkOptions {
  readonly hash?: HashFn;
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

export function verifyAuditChain(entries: readonly AuditEntry[], hash: HashFn): boolean {
  let previous = "0";
  for (const entry of entries) {
    if (entry.prevHash !== previous) return false;
    if (entry.hash !== hash(fingerprint(entry.seq, entry.prevHash, entry.record))) return false;
    previous = entry.hash;
  }
  return true;
}

export function createAuditSink(options: AuditSinkOptions = {}): AuditSink {
  const hash = options.hash ?? defaultHash;
  const entries: AuditEntry[] = [];
  let drops = 0;

  return {
    get entries(): readonly AuditEntry[] {
      return entries;
    },
    append(record: AuditRecord): AuditEntry {
      const seq = entries.length;
      const prevHash = seq === 0 ? "0" : entries[seq - 1]!.hash;
      const entry: AuditEntry = {
        seq,
        record,
        prevHash,
        hash: hash(fingerprint(seq, prevHash, record)),
      };
      entries.push(entry);
      return entry;
    },
    noteDrop(): void {
      drops += 1;
    },
    finalized(revision: number): FinalizedState {
      if (!Number.isInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
      if (revision > entries.length) return "incomplete";
      return drops > 0 ? "complete-with-drops" : "complete";
    },
  };
}
