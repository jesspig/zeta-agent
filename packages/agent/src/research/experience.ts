import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ExperienceEntry {
  readonly id: string;
  readonly candidate: string;
  readonly kind: string;
  readonly code: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly traces: readonly string[];
  readonly [key: string]: unknown;
}

export type ExperienceQuery = {
  readonly candidate?: string;
  readonly kind?: string;
  readonly regex?: string;
};

export interface ExperienceDiff {
  readonly a: string;
  readonly b: string;
  readonly scoreDelta: Readonly<Record<string, number>>;
  readonly codeChanged: boolean;
}

export type ExperienceOp = {
  readonly kind: "put";
  readonly entry: ExperienceEntry;
};

export interface ExperienceStore {
  put(entry: ExperienceEntry): void;
  get(id: string): ExperienceEntry | undefined;
  all(): readonly ExperienceEntry[];
  query(criteria: ExperienceQuery): readonly ExperienceEntry[];
  frontier(metric: string): readonly ExperienceEntry[];
  diff(a: string, b: string): ExperienceDiff;
  snapshot(): string;
  restore(snapshot: string): void;
}

/** 可注入的 evidence 存储适配器；默认内存实现保留，研究 seam 不进默认装配。 */
export interface ExperiencePersistence {
  load(): readonly ExperienceEntry[] | undefined;
  save(entries: readonly ExperienceEntry[]): void;
}

export interface ExperienceStoreOptions {
  readonly persistence?: ExperiencePersistence;
}

const LEAKAGE_KEYS = new Set([
  "verdict",
  "rubric",
  "graderscore",
  "groundtruth",
  "istest",
  "testcase",
  "hiddentest",
  "expected",
  "expectedoutput",
]);

function assertNoLeakage(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoLeakage(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (LEAKAGE_KEYS.has(key.toLowerCase())) {
      throw new Error(`LEAKAGE_TRIPWIRE: ${key}`);
    }
    assertNoLeakage(child);
  }
}

function assertEntry(entry: ExperienceEntry): void {
  if (entry === null || typeof entry !== "object") throw new Error("INVALID_ENTRY");
  if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error("INVALID_ENTRY_ID");
  assertNoLeakage(entry);
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function createInMemoryExperiencePersistence(): ExperiencePersistence {
  let stored: readonly ExperienceEntry[] | undefined;
  return {
    load: () => stored,
    save: (entries) => {
      stored = structuredClone(entries) as ExperienceEntry[];
    },
  };
}

/** 文件适配器：code/scores/traces 等 evidence 字段完整 JSON 落盘，不持有有损摘要。 */
export function createFileExperiencePersistence(filePath: string): ExperiencePersistence {
  if (typeof filePath !== "string" || filePath.length === 0) throw new Error("INVALID_EXPERIENCE_PATH");
  return {
    load() {
      if (!existsSync(filePath)) return undefined;
      return JSON.parse(readFileSync(filePath, "utf8")) as ExperienceEntry[];
    },
    save(entries) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(entries), "utf8");
    },
  };
}

export function createExperienceStore(options: ExperienceStoreOptions = {}): ExperienceStore {
  const persistence = options.persistence ?? createInMemoryExperiencePersistence();
  const entries = new Map<string, ExperienceEntry>();
  const restored = persistence.load();
  if (restored !== undefined) {
    for (const item of restored) {
      assertEntry(item);
      entries.set(item.id, structuredClone(item) as ExperienceEntry);
    }
  }
  const persist = (): void => {
    persistence.save([...entries.values()]);
  };

  function requireEntry(id: string): ExperienceEntry {
    const found = entries.get(id);
    if (found === undefined) throw new Error(`EXPERIENCE_NOT_FOUND: ${id}`);
    return found;
  }

  return {
    put(entry) {
      assertEntry(entry);
      entries.set(entry.id, structuredClone(entry) as ExperienceEntry);
      persist();
    },
    get(id) {
      return entries.get(id);
    },
    all() {
      return Object.freeze([...entries.values()]);
    },
    query(criteria) {
      let matcher: RegExp | undefined;
      if (criteria.regex !== undefined) {
        try {
          matcher = new RegExp(criteria.regex);
        } catch {
          throw new Error(`INVALID_REGEX: ${criteria.regex}`);
        }
      }
      return Object.freeze(
        [...entries.values()].filter((item) => {
          if (criteria.candidate !== undefined && item.candidate !== criteria.candidate) return false;
          if (criteria.kind !== undefined && item.kind !== criteria.kind) return false;
          return matcher === undefined || matcher.test(item.code);
        })
      );
    },
    frontier(metric) {
      let best: number | undefined;
      for (const item of entries.values()) {
        const value = item.scores[metric];
        if (typeof value === "number" && Number.isFinite(value)) {
          best = best === undefined || value > best ? value : best;
        }
      }
      if (best === undefined) return Object.freeze([]);
      return Object.freeze(
        [...entries.values()].filter((item) => item.scores[metric] === best)
      );
    },
    diff(a, b) {
      const left = requireEntry(a);
      const right = requireEntry(b);
      const keys = new Set([...Object.keys(left.scores), ...Object.keys(right.scores)]);
      const scoreDelta: Record<string, number> = {};
      for (const key of keys) {
        scoreDelta[key] = (right.scores[key] ?? 0) - (left.scores[key] ?? 0);
      }
      return Object.freeze({
        a,
        b,
        scoreDelta: Object.freeze(scoreDelta),
        codeChanged: left.code !== right.code,
      });
    },
    snapshot() {
      const ordered = [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
      return stableStringify(ordered);
    },
    restore(snapshot) {
      const parsed: unknown = JSON.parse(snapshot);
      if (!Array.isArray(parsed)) throw new Error("INVALID_SNAPSHOT");
      entries.clear();
      for (const item of parsed) {
        const candidate = item as ExperienceEntry;
        assertEntry(candidate);
        entries.set(candidate.id, candidate);
      }
      persist();
    },
  };
}

export function replayExperience(ops: readonly ExperienceOp[]): ExperienceStore {
  const store = createExperienceStore();
  for (const op of ops) {
    if (op.kind !== "put") throw new Error(`UNKNOWN_EXPERIENCE_OP: ${op.kind}`);
    store.put(op.entry);
  }
  return store;
}
