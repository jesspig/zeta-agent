import { AsyncLocalStorage } from "node:async_hooks";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { FiberId } from "@zeta-agent/framework";

/**
 * cordis 官方 HMR 的 Bun 适配版（显式偏离，非官方实现）。
 * - 官方强依赖 Node ≥22 内部 API：`ModuleLoader.fromInternal()` + `--expose-internals`、
 *   ESM loadCache / CJS require.cache 的 evict/restore、`restoreResolutions`。Bun 无这些能力。
 *   本实现保留等价路径：构建产物独立 data URL（内容寻址）+ `Fiber.reload` 复用同一 identity，
 *   快照只作用于 hmr.ts 自身的 states / instance 引用。
 * - unit 连通分组简化：官方按"共享驱逐模块的连通单元"分区（_partition），
 *   这里 unit = FiberId 独立分组（data URL 内容寻址使各产物互不共享模块图）。
 */
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

/** detail 中的单条记录：aborted 带 error，skipped 带 reason。 */
export interface HmrDetailEntry {
  readonly id: FiberId;
  readonly reason?: SkipReason;
  readonly error?: unknown;
}

/** 结构化明细，与顶层 string[] 一一对应（cordis Result{settled,aborted,skipped} 风格）。 */
export interface HmrDetail {
  readonly settled: HmrDetailEntry[];
  readonly aborted: HmrDetailEntry[];
  readonly skipped: HmrDetailEntry[];
}

export interface HmrResult {
  // string[] 保留既有断言语义（settled/aborted/skipped/retried 仍是 id 数组）；
  // detail 为新增的结构化信息，不改变 string[] 的取值。
  readonly settled: string[];
  readonly aborted: string[];
  readonly skipped: string[];
  readonly retried: string[];
  readonly detail: HmrDetail;
}

/**
 * 单个 unit 在 build/evaluate 前的快照：
 * - instance：旧导出实例引用，失败时恢复，宿主持有的导出不被破坏；
 * - committed：旧已提交状态对象引用，restore 后 stateOf(id) 返回同一对象；
 * - version：快照时确定的拟写版本号（避免循环内重复计算）。
 */
export interface UnitSnapshot {
  readonly id: FiberId;
  readonly instance: UnitInstance | undefined;
  readonly committed: UnitState | undefined;
  readonly version: number;
}

/** 一次事务在所有 build/evaluate 前的快照集合。 */
export interface ReconcileSnapshot {
  readonly units: ReadonlyMap<FiberId, UnitSnapshot>;
}

/** 显式备份：失败时按 unit id 恢复旧实例与 committed 引用。 */
export interface SnapshotBackup {
  restore(ids: readonly FiberId[]): void;
}

/**
 * 构造快照与备份。必须在任何 build/evaluate 写入前调用。
 * 恢复逐 unit 进行：只恢复传入的 ids，其他 unit 的正常提交不受影响
 * （对应 cordis 的"按 unit 部分恢复"：`backup.restore(aborted ∪ skipped)`）。
 */
export function snapshotAndBackup(
  units: readonly UnitRef[],
  states: Map<FiberId, UnitState>
): { snapshot: ReconcileSnapshot; backup: SnapshotBackup } {
  const captured = new Map<FiberId, UnitSnapshot>();
  for (const unit of units) {
    const committed = states.get(unit.id);
    captured.set(unit.id, {
      id: unit.id,
      instance: committed?.instance,
      committed,
      version: (committed?.version ?? 0) + 1,
    });
  }
  const snapshot: ReconcileSnapshot = { units: captured };
  const backup: SnapshotBackup = {
    restore(ids) {
      for (const id of ids) {
        const snap = captured.get(id);
        if (snap === undefined) continue;
        // 恢复旧 UnitState 对象引用（含 instance 旧导出）；无旧状态时移除。
        if (snap.committed === undefined) states.delete(id);
        else states.set(id, snap.committed);
      }
    },
  };
  return { snapshot, backup };
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
    const result: HmrResult = {
      settled: [],
      aborted: [],
      skipped: [],
      retried: [],
      detail: { settled: [], aborted: [], skipped: [] },
    };
    if (changed.length === 0) return result;

    const targets: Array<{ unit: UnitRef; retry: boolean }> = [];
    for (const item of opts.units) {
      const wasFailed = failedUnits.has(item.id);
      const stale = matchesFile(item, changed);
      // wasFailed 同时覆盖 apply 失败的 FAILED 单元与 aborted 的 retained 单元：
      // 二者都在下次文件变更时无条件重试（cordis retained / resume 语义）。
      if (stale || wasFailed) targets.push({ unit: item, retry: wasFailed });
    }

    // 在任何 build/evaluate 前建立显式快照，替代旧的"失败时不写 states"被动恢复。
    const { snapshot, backup } = snapshotAndBackup(
      targets.map((target) => target.unit),
      states
    );

    const candidates: Array<{ unit: UnitRef; state: UnitState; retry: boolean }> = [];
    const abortedIds: FiberId[] = [];
    const skippedIds: FiberId[] = [];
    for (const { unit, retry } of targets) {
      const reason = opts.classify?.(unit, changed);
      if (reason !== undefined) {
        result.skipped.push(unit.id);
        skippedIds.push(unit.id);
        result.detail.skipped.push({ id: unit.id, reason });
        continue;
      }
      const version = snapshot.units.get(unit.id)!.version;
      try {
        const artifact = await opts.build(unit, version);
        const instance = await opts.evaluate(artifact);
        candidates.push({
          unit,
          state: { unit, version, artifact, instance, status: "ACTIVE" },
          retry,
        });
      } catch (error) {
        result.aborted.push(unit.id);
        abortedIds.push(unit.id);
        result.detail.aborted.push({ id: unit.id, error });
      }
    }

    // 失败/跳过的单元从快照显式恢复旧实例与 committed 引用；其他单元正常提交。
    backup.restore([...abortedIds, ...skippedIds]);
    // aborted 单元加入 failedUnits（等价 cordis 的 retained）：下次文件变更自动重试；
    // skipped 单元需要重启，不自动重试。
    for (const id of abortedIds) failedUnits.add(id);

    for (const { unit, state, retry } of candidates) {
      try {
        await opts.apply(unit, state.instance);
        states.set(unit.id, state);
        failedUnits.delete(unit.id);
        result.settled.push(unit.id);
        result.detail.settled.push({ id: unit.id });
        if (retry) result.retried.push(unit.id);
      } catch (error) {
        // cordis Stage 3：apply 失败留 FAILED，不回滚，下次文件变更重试。
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
