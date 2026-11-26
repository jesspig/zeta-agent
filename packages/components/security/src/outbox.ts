/**
 * 持久 outbox（IF-14）：领域事务内 enqueue，commit 后派发；每条意图都有稳定幂等键。
 * 先落「dispatching」再派发、先落回执再移除，覆盖 commit 前与 dispatch 后两个崩溃窗口。
 * dispatching 但无回执的意图在恢复时标记 unknown，停止自动重放，等待显式对账。
 */

export type OutboxState = "queued" | "dispatching" | "unknown" | "settled" | "deferred";

/** 历史快照没有该字段，读取时一律视为 1；高于当前版本则失败关闭。 */
export const OUTBOX_SCHEMA_VERSION = 1;

export interface OutboxEntry {
  readonly kind: string;
  readonly key: string;
  readonly seq: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly state: OutboxState;
  readonly generation: number;
  readonly attempts: number;
  readonly deferUntil?: number;
}

export interface OutboxReceipt {
  readonly kind: string;
  readonly key: string;
  readonly ok: boolean;
  readonly value?: unknown;
  /** 历史 receipt 可缺字段：读取时只读兼容，不重写旧回执。 */
  readonly idempotencyKey?: string;
  readonly generation?: number;
}

export interface OutboxSnapshot {
  readonly schemaVersion?: number;
  readonly seq: number;
  readonly pending: readonly OutboxEntry[];
  readonly receipts: readonly OutboxReceipt[];
  readonly seen: readonly string[];
  readonly revision: number;
  readonly consecutiveFailures: number;
}

export interface OutboxJournal {
  load(): OutboxSnapshot | undefined;
  save(snapshot: OutboxSnapshot): void;
}

export interface RecoverResult {
  readonly restored: boolean;
  readonly pending: number;
  readonly receipts: number;
  readonly unknown: number;
}

export interface OutboxHealth {
  readonly ok: boolean;
  readonly consecutiveFailures: number;
  readonly reason?: string;
}

export type FailOutcome =
  | { readonly retry: true; readonly entry: OutboxEntry }
  | { readonly retry: false; readonly receipt: OutboxReceipt };

export interface PersistentOutboxOptions {
  readonly journal: OutboxJournal;
  readonly maxAttempts?: number;
  readonly healthThreshold?: number;
  readonly now?: () => number;
}

export interface PersistentOutbox {
  enqueue(kind: string, key: string, payload: unknown): OutboxEntry;
  entries(): readonly OutboxEntry[];
  receipts(): readonly OutboxReceipt[];
  beginDispatch(entry: OutboxEntry): OutboxEntry;
  settle(entry: OutboxEntry, ok: boolean, value?: unknown): OutboxReceipt;
  fail(entry: OutboxEntry): FailOutcome;
  later(entry: OutboxEntry, delayMs?: number): OutboxEntry;
  reconcile(key: string, ok: boolean, value?: unknown): OutboxReceipt;
  unknown(): readonly OutboxEntry[];
  dispatchable(): readonly OutboxEntry[];
  retryDeferred(): void;
  recover(): RecoverResult;
  health(): OutboxHealth;
  resetHealth(): void;
  revision(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}: expected a non-empty string`);
}

export function createInMemoryOutboxJournal(): OutboxJournal {
  let snapshot: OutboxSnapshot | undefined;
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next) as OutboxSnapshot;
    },
  };
}

export function createPersistentOutbox(options: PersistentOutboxOptions): PersistentOutbox {
  const journal = options.journal;
  if (!isRecord(journal) || typeof journal.load !== "function" || typeof journal.save !== "function") {
    throw new Error("INVALID_OUTBOX_JOURNAL");
  }
  const now = options.now ?? (() => Date.now());
  const maxAttempts = options.maxAttempts ?? 3;
  const healthThreshold = options.healthThreshold ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("INVALID_OUTBOX_MAX_ATTEMPTS");
  if (!Number.isInteger(healthThreshold) || healthThreshold < 1) throw new Error("INVALID_OUTBOX_HEALTH_THRESHOLD");

  let seq = 0;
  let revision = 0;
  let consecutiveFailures = 0;
  let pending: OutboxEntry[] = [];
  let receipts: OutboxReceipt[] = [];
  let seen = new Set<string>();

  const persist = (): void => {
    revision += 1;
    journal.save({
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      seq,
      pending: pending.map((entry) => ({ ...entry })),
      receipts: receipts.map((receipt) => ({ ...receipt })),
      seen: [...seen],
      revision,
      consecutiveFailures,
    });
  };

  function replace(entry: OutboxEntry, patch: Partial<OutboxEntry>): OutboxEntry {
    const index = pending.findIndex((item) => item.seq === entry.seq);
    if (index < 0) throw new Error("OUTBOX_ENTRY_NOT_PENDING");
    const next: OutboxEntry = { ...entry, ...patch };
    pending[index] = next;
    persist();
    return next;
  }

  /** 只接受当前仍处于 dispatching 的同一代次，陈旧确认一律拒绝，避免重复回执/重复计费。 */
  function requireDispatching(entry: OutboxEntry): OutboxEntry {
    const current = pending.find((item) => item.seq === entry.seq);
    if (
      current === undefined ||
      current.state !== "dispatching" ||
      current.generation !== entry.generation ||
      current.idempotencyKey !== entry.idempotencyKey
    ) {
      throw new Error("OUTBOX_NOT_DISPATCHABLE");
    }
    return current;
  }

  function finish(entry: OutboxEntry, ok: boolean, value?: unknown): OutboxReceipt {
    pending = pending.filter((item) => item.seq !== entry.seq);
    const receipt: OutboxReceipt = {
      kind: entry.kind,
      key: entry.key,
      ok,
      ...(value === undefined ? {} : { value }),
      idempotencyKey: entry.idempotencyKey,
      generation: entry.generation,
    };
    receipts.push(receipt);
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    persist();
    return receipt;
  }

  function recover(): RecoverResult {
    const snapshot = journal.load();
    if (snapshot === undefined) {
      return { restored: false, pending: pending.length, receipts: receipts.length, unknown: unknown().length };
    }
    const schemaVersion = snapshot.schemaVersion ?? OUTBOX_SCHEMA_VERSION;
    if (!Number.isInteger(schemaVersion) || schemaVersion > OUTBOX_SCHEMA_VERSION) {
      throw new Error("OUTBOX_SCHEMA_UNSUPPORTED");
    }
    if (
      !Number.isInteger(snapshot.seq) ||
      !Number.isInteger(snapshot.revision) ||
      !Number.isInteger(snapshot.consecutiveFailures) ||
      !Array.isArray(snapshot.pending) ||
      !Array.isArray(snapshot.receipts) ||
      !Array.isArray(snapshot.seen)
    ) {
      throw new Error("INVALID_OUTBOX_SNAPSHOT");
    }
    seq = snapshot.seq;
    revision = snapshot.revision;
    consecutiveFailures = snapshot.consecutiveFailures;
    receipts = snapshot.receipts.map((receipt) => ({ ...receipt }));
    seen = new Set(snapshot.seen);
    const settledKeys = new Set(
      receipts.map((receipt) => receipt.idempotencyKey ?? `${receipt.kind}\u0000${receipt.key}`)
    );
    pending = snapshot.pending.map((entry) =>
      entry.state === "dispatching" && !settledKeys.has(entry.idempotencyKey)
        ? { ...entry, state: "unknown" as const }
        : { ...entry }
    );
    if (pending.some((entry) => entry.state === "unknown")) persist();
    return { restored: true, pending: pending.length, receipts: receipts.length, unknown: unknown().length };
  }

  function unknown(): readonly OutboxEntry[] {
    return pending.filter((entry) => entry.state === "unknown").map((entry) => ({ ...entry }));
  }

  // 构造即恢复：调用方无需记得显式 recover。
  recover();

  return {
    enqueue(kind, key, payload) {
      assertKey(kind, "outbox.enqueue kind");
      assertKey(key, "outbox.enqueue key");
      const idempotencyKey = `${kind}\u0000${key}`;
      if (seen.has(idempotencyKey)) {
        const existing = pending.find((entry) => entry.idempotencyKey === idempotencyKey);
        if (existing !== undefined) return { ...existing };
        const prior = [...receipts].reverse().find((receipt) => receipt.idempotencyKey === idempotencyKey);
        return {
          kind,
          key,
          seq: 0,
          payload,
          idempotencyKey,
          state: "settled",
          generation: prior?.generation ?? 0,
          attempts: prior?.generation ?? 0,
        };
      }
      seen.add(idempotencyKey);
      seq += 1;
      const entry: OutboxEntry = {
        kind,
        key,
        seq,
        payload,
        idempotencyKey,
        state: "queued",
        generation: 0,
        attempts: 0,
      };
      pending.push(entry);
      persist();
      return { ...entry };
    },
    entries() {
      return pending.map((entry) => ({ ...entry }));
    },
    receipts() {
      return receipts.map((receipt) => ({ ...receipt }));
    },
    beginDispatch(entry) {
      const current = pending.find((item) => item.seq === entry.seq);
      if (current === undefined || current.state !== "queued") throw new Error("OUTBOX_NOT_DISPATCHABLE");
      return replace(current, { state: "dispatching", generation: current.generation + 1, attempts: current.attempts + 1 });
    },
    settle(entry, ok, value) {
      return finish(requireDispatching(entry), ok, value);
    },
    fail(entry) {
      const current = requireDispatching(entry);
      if (current.attempts < maxAttempts) {
        const retried = replace(current, { state: "queued", generation: current.generation + 1 });
        return { retry: true, entry: retried };
      }
      return { retry: false, receipt: finish(current, false) };
    },
    later(entry, delayMs = 0) {
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("INVALID_OUTBOX_DELAY");
      const current = pending.find((item) => item.seq === entry.seq);
      if (current === undefined) throw new Error("OUTBOX_ENTRY_NOT_PENDING");
      return replace(current, { state: "deferred", deferUntil: now() + delayMs });
    },
    reconcile(key, ok, value) {
      const entry = pending.find((item) => item.key === key && item.state === "unknown");
      if (entry === undefined) throw new Error("UNKNOWN_OUTBOX_ENTRY");
      return finish(entry, ok, value);
    },
    unknown,
    dispatchable() {
      return pending.filter((entry) => entry.state === "queued").map((entry) => ({ ...entry }));
    },
    retryDeferred() {
      const at = now();
      let changed = false;
      pending = pending.map((entry) => {
        if (entry.state !== "deferred" || entry.deferUntil === undefined || entry.deferUntil > at) return entry;
        changed = true;
        const { deferUntil: _deferUntil, ...rest } = entry;
        void _deferUntil;
        return { ...rest, state: "queued" as const };
      });
      if (changed) persist();
    },
    recover,
    health() {
      return consecutiveFailures >= healthThreshold
        ? { ok: false, consecutiveFailures, reason: "EFFECTS_HEALTH_ERROR" }
        : { ok: true, consecutiveFailures };
    },
    resetHealth() {
      consecutiveFailures = 0;
      persist();
    },
    revision() {
      return revision;
    },
  };
}
