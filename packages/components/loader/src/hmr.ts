import { AsyncLocalStorage } from "node:async_hooks";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { FiberId } from "@zeta-agent/framework";

export interface UnitRef {
  readonly id: FiberId;
  readonly file: string;
}

export interface BuildArtifact {
  readonly id: string;
  readonly version: number;
}

export interface UnitInstance {
  readonly artifact: string;
  readonly value: unknown;
}

export type UnitStatus = "ACTIVE" | "FAILED";

export interface UnitState {
  readonly unit: UnitRef;
  readonly version: number;
  readonly artifact: BuildArtifact;
  readonly instance: UnitInstance;
  readonly status: UnitStatus;
  readonly error?: unknown;
}

export type SkipReason = "host-module" | "native-addon" | "ambiguous-import" | "ambiguous-export";

export interface HmrResult {
  readonly settled: string[];
  readonly aborted: string[];
  readonly skipped: string[];
  readonly retried: string[];
}

export interface HmrOptions {
  readonly units: readonly UnitRef[];
  readonly build: (unit: UnitRef, version: number) => BuildArtifact | Promise<BuildArtifact>;
  readonly evaluate: (artifact: BuildArtifact) => UnitInstance | Promise<UnitInstance>;
  readonly apply: (unit: UnitRef, instance: UnitInstance) => void | Promise<void>;
  readonly classify?: (unit: UnitRef, changedFiles: readonly string[]) => SkipReason | undefined;
  readonly auto?: boolean;
  readonly debounceMs?: number;
}

export interface HmrWatcher {
  readonly root: string;
  readonly strategy: "artifact-version-fresh-eval";
  markDirty(files: readonly string[]): void;
  flush(): Promise<HmrResult>;
  ready(): Promise<void>;
  failed(): readonly string[];
  stateOf(id: FiberId): UnitState | undefined;
  close(): void;
}

const inTransaction = new AsyncLocalStorage<boolean>();
let queueTail: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  if (inTransaction.getStore() === true) return Promise.reject(new Error("HMR_NESTED"));
  const run = (): Promise<T> => inTransaction.run(true, async () => await fn());
  const result = queueTail.then(run, run);
  queueTail = result.then(() => undefined, () => undefined);
  return result;
}

function matchesFile(item: UnitRef, changedFiles: readonly string[]): boolean {
  return changedFiles.some(
    (file) => file === item.file || item.file.endsWith(`/${file}`) || file.endsWith(`/${item.file}`)
  );
}

export function watch(root: string, opts: HmrOptions): HmrWatcher {
  const seen = new Set<FiberId>();
  for (const item of opts.units) {
    if (seen.has(item.id)) throw new Error("DUPLICATE_HMR_UNIT");
    seen.add(item.id);
  }

  const dirty = new Set<string>();
  const states = new Map<FiberId, UnitState>();
  const failedUnits = new Set<FiberId>();
  let fsWatcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const markDirty = (files: readonly string[]): void => {
    for (const file of files) dirty.add(file);
  };

  async function transaction(): Promise<HmrResult> {
    const changed = [...dirty];
    dirty.clear();
    const result: HmrResult = { settled: [], aborted: [], skipped: [], retried: [] };
    if (changed.length === 0) return result;

    const targets: Array<{ unit: UnitRef; retry: boolean }> = [];
    for (const item of opts.units) {
      const wasFailed = failedUnits.has(item.id);
      const stale = matchesFile(item, changed);
      if (stale || wasFailed) targets.push({ unit: item, retry: wasFailed });
    }

    const candidates: Array<{ unit: UnitRef; state: UnitState; retry: boolean }> = [];
    for (const { unit, retry } of targets) {
      if (opts.classify?.(unit, changed) !== undefined) {
        result.skipped.push(unit.id);
        continue;
      }
      const backup = states.get(unit.id);
      const version = (backup?.version ?? 0) + 1;
      try {
        const artifact = await opts.build(unit, version);
        const instance = await opts.evaluate(artifact);
        candidates.push({
          unit,
          state: { unit, version, artifact, instance, status: "ACTIVE" },
          retry,
        });
      } catch {
        result.aborted.push(unit.id);
      }
    }

    for (const { unit, state, retry } of candidates) {
      try {
        await opts.apply(unit, state.instance);
        states.set(unit.id, state);
        failedUnits.delete(unit.id);
        result.settled.push(unit.id);
        if (retry) result.retried.push(unit.id);
      } catch (error) {
        states.set(unit.id, { ...state, status: "FAILED", error });
        failedUnits.add(unit.id);
      }
    }
    return result;
  }

  function flush(): Promise<HmrResult> {
    return runExclusive(transaction);
  }

  if (opts.auto === true) {
    fsWatcher = fsWatch(root, (_event, filename) => {
      if (typeof filename !== "string") return;
      // 立即登记脏文件，只对 flush 防抖，避免同窗口内较早变更被丢弃。
      markDirty([filename]);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void flush();
      }, opts.debounceMs ?? 100);
    });
  }

  return {
    root,
    strategy: "artifact-version-fresh-eval",
    markDirty,
    flush,
    ready: async () => {
      await queueTail;
    },
    failed: () => [...failedUnits],
    stateOf: (id) => states.get(id),
    close: () => {
      if (debounce) clearTimeout(debounce);
      fsWatcher?.close();
      fsWatcher = null;
    },
  };
}
