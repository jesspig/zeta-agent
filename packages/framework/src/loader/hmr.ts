import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { ComponentRegistry } from "./registry";

/** 输入闭包 digest：sha256 十六进制。 */
export function digestText(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface FileSignature {
  readonly path: string;
  readonly digest: string;
}

export type FileReader = (path: string) => string | Uint8Array | undefined;

/** 文件签名 = 路径 + 内容 digest；事务前登记，flush 时与真实内容核对。 */
export function signFile(path: string, read: FileReader): FileSignature {
  const content = read(path);
  if (content === undefined) throw new Error(`HMR_FILE_MISSING: ${path}`);
  return { path, digest: digestText(content) };
}

export function normalizePath(path: string): string {
  const withSlashes = path.replace(/\\/g, "/");
  const absolute = withSlashes.startsWith("/") || /^[A-Za-z]:\//.test(withSlashes);
  const parts: string[] = [];
  for (const part of withSlashes.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (!absolute) return joined;
  return /^[A-Za-z]:\//.test(withSlashes) ? joined : `/${joined}`;
}

function resolveRelative(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return normalizePath(specifier);
  const slash = fromFile.lastIndexOf("/");
  const dir = slash >= 0 ? fromFile.slice(0, slash) : "";
  return normalizePath(dir === "" ? specifier : `${dir}/${specifier}`);
}

/** 解析静态 import / export-from 与动态 import() 的局部路径。 */
export function parseImports(source: string, fromFile: string): readonly string[] {
  const found = new Set<string>();
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    found.add(resolveRelative(normalizePath(fromFile), specifier));
  }
  return [...found].sort();
}

export interface ImportGraph {
  readonly nodes: readonly string[];
  /** file → 它直接导入的局部文件（已规范化）。 */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

/** 解析无扩展名相对导入（TS/JS 常见写法）；读不到视为宿主模块。 */
function resolveLocal(read: FileReader, specifier: string): string | undefined {
  const candidates = [
    specifier,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}.js`,
    `${specifier}.mjs`,
    `${specifier}/index.ts`,
  ];
  for (const candidate of candidates) {
    if (read(candidate) !== undefined) return normalizePath(candidate);
  }
  return undefined;
}

/** 从入口出发读取文件、解析静态依赖，构造传递闭包图（读不到的依赖视为宿主模块）。 */
export function buildImportGraph(entries: readonly string[], read: FileReader): ImportGraph {
  const edges = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue = entries.map(normalizePath);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const content = read(current);
    const imports = typeof content === "string" ? parseImports(content, current) : [];
    const resolved = imports
      .map((item) => resolveLocal(read, item))
      .filter((item): item is string => item !== undefined);
    edges.set(current, resolved);
    for (const item of resolved) {
      if (!visited.has(item)) queue.push(item);
    }
  }
  return {
    nodes: [...visited].sort(),
    edges: Object.fromEntries([...edges].map(([key, value]) => [key, [...value].sort()])),
  };
}

/** 简单环检测：返回规范化后的环节点序列；自环与多节点环均可观察。 */
export function detectCycles(graph: ImportGraph): readonly (readonly string[])[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    const status = state.get(node) ?? 0;
    if (status === 1) {
      const start = stack.indexOf(node);
      if (start >= 0) cycles.push([...stack.slice(start), node]);
      return;
    }
    if (status === 2) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.edges[node] ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.nodes) visit(node);
  return cycles.map((cycle) => Object.freeze(cycle));
}

/** 入口的完整传递闭包（含入口自身），已排序去重。 */
export function closureOf(graph: ImportGraph, entry: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [normalizePath(entry)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of graph.edges[current] ?? []) queue.push(next);
  }
  return [...seen].sort();
}

/** 闭包 digest：仅由闭包内每个文件的当前签名决定。 */
export function closureDigest(
  graph: ImportGraph,
  entry: string,
  signatures: ReadonlyMap<string, string>
): string {
  const parts = closureOf(graph, entry).map(
    (file) => `${file}\u0000${signatures.get(file) ?? digestText(file)}`
  );
  return digestText(parts.join("\u0001"));
}

export interface GraphAnalysis {
  /** 变更被 accept 边界吸收的模块。 */
  readonly accepted: readonly string[];
  /** 没有 accept 边界、需向上传播的模块。 */
  readonly declined: readonly string[];
  /** 共享变更模块的连通 unit 分组（unit id）。 */
  readonly partitions: readonly (readonly string[])[];
  /** 当前 import graph 的环；每次事务重建后重新计算。 */
  readonly cycles: readonly (readonly string[])[];
}

const EMPTY_GRAPH: ImportGraph = { nodes: [], edges: {} };
const EMPTY_ANALYSIS: GraphAnalysis = Object.freeze({
  accepted: [],
  declined: [],
  partitions: [],
  cycles: [],
});

/**
 * accepted/declined 不动点：变更从模块出发沿反向 import 边传播，遇到 accept 边界即停；
 * 没有边界的模块持续向上传播至根。共享同一变更模块的入口归入同一连通单元（共同 apply）。
 */
export function analyzeGraph(
  graph: ImportGraph,
  changed: readonly string[],
  entries: readonly string[],
  accepts: readonly string[]
): GraphAnalysis {
  const acceptedBoundaries = new Set(accepts.map(normalizePath));
  const importers = new Map<string, string[]>();
  for (const [file, imports] of Object.entries(graph.edges)) {
    for (const imported of imports) {
      const list = importers.get(imported) ?? [];
      list.push(file);
      importers.set(imported, list);
    }
  }

  const declined = new Set<string>();
  const accepted = new Set<string>();
  const queue = changed.map(normalizePath);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (declined.has(current) || accepted.has(current)) continue;
    if (acceptedBoundaries.has(current)) {
      accepted.add(current);
      continue;
    }
    declined.add(current);
    for (const importer of importers.get(current) ?? []) {
      if (!declined.has(importer) && !accepted.has(importer)) queue.push(importer);
    }
  }

  const closures = new Map<string, Set<string>>(
    entries.map((entry) => [normalizePath(entry), new Set(closureOf(graph, entry))])
  );
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    let root = value;
    while (parent.get(root) !== undefined) root = parent.get(root)!;
    while (parent.get(value) !== undefined && parent.get(value) !== root) {
      const next = parent.get(value)!;
      parent.set(value, root);
      value = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  for (const [left, leftClosure] of closures) {
    for (const [right, rightClosure] of closures) {
      if (left === right) continue;
      const shared = [...leftClosure].some((file) => declined.has(file) && rightClosure.has(file));
      if (shared) union(left, right);
    }
  }
  const groups = new Map<string, string[]>();
  for (const entry of closures.keys()) {
    if (![...closures.get(entry)!].some((file) => declined.has(file))) continue;
    const root = find(entry);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  }
  return {
    accepted: [...accepted].sort(),
    declined: [...declined].sort(),
    partitions: [...groups.values()].map((group) => [...group].sort()),
    cycles: detectCycles(graph),
  };
}

export type HmrStatus = "ACTIVE" | "FAILED";
export type SkipReason =
  | "host-module"
  | "native-addon"
  | "ambiguous-import"
  | "ambiguous-export"
  | "signature-mismatch";

export interface HmrUnit {
  readonly id: string;
  readonly entry: string;
  readonly accepts?: readonly string[];
}

export interface BuildArtifact {
  readonly id: string;
  readonly digest: string;
  readonly version: number;
  /** 内容寻址产物代码；data URL 求值器使用，其他构建器可忽略。 */
  readonly code?: string;
}

export interface UnitInstance {
  readonly artifact: string;
  readonly value: unknown;
}

export interface HmrState {
  readonly unit: HmrUnit;
  /** 同 fiber 原地 replace 的版本号（保留 uid/parent/config）。 */
  readonly revision: number;
  readonly digest: string;
  readonly artifact: BuildArtifact;
  readonly instance: UnitInstance;
  readonly status: HmrStatus;
  readonly error?: unknown;
}

export interface HmrDetailEntry {
  readonly id: string;
  readonly reason?: SkipReason;
  readonly error?: unknown;
}

export interface HmrResult {
  readonly settled: string[];
  /** digest 未变、复用旧求值对象，未调用 build/evaluate。 */
  readonly reused: string[];
  readonly aborted: string[];
  readonly skipped: string[];
  readonly retried: string[];
  readonly detail: {
    readonly settled: HmrDetailEntry[];
    readonly reused: HmrDetailEntry[];
    readonly aborted: HmrDetailEntry[];
    readonly skipped: HmrDetailEntry[];
  };
}

export interface UnitSnapshot {
  readonly id: string;
  readonly state: HmrState | undefined;
  readonly revision: number;
}

export interface SnapshotBackup {
  restore(ids: readonly string[]): void;
}

/** 在任何 build/evaluate 前捕获旧状态引用；失败时按 unit 部分恢复。 */
export function snapshotAndBackup(
  units: readonly HmrUnit[],
  states: Map<string, HmrState>
): { snapshot: ReadonlyMap<string, UnitSnapshot>; backup: SnapshotBackup } {
  const snapshot = new Map<string, UnitSnapshot>();
  for (const unit of units) {
    const state = states.get(unit.id);
    snapshot.set(unit.id, { id: unit.id, state, revision: (state?.revision ?? 0) + 1 });
  }
  return {
    snapshot,
    backup: {
      restore(ids) {
        for (const id of ids) {
          const captured = snapshot.get(id);
          if (captured === undefined) continue;
          if (captured.state === undefined) states.delete(id);
          else states.set(id, captured.state);
        }
      },
    },
  };
}

/** 事务队列按 controller 实例隔离；ready() 只等待本实例的在途事务。 */
export interface HmrQueue {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  ready(): Promise<void>;
}

export function createHmrQueue(): HmrQueue {
  const inTransaction = new AsyncLocalStorage<boolean>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => T | Promise<T>) {
      if (inTransaction.getStore() === true) return Promise.reject(new Error("HMR_NESTED"));
      const execute = (): Promise<T> => inTransaction.run(true, async () => await fn());
      const result = tail.then(execute, execute);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async ready() {
      await tail;
    },
  };
}

const sharedQueue = createHmrQueue();

/** 兼容独立工具入口的全局队列；controller 自身使用实例队列。 */
export function runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  return sharedQueue.run(fn);
}

function pathMatches(candidate: string, changed: string): boolean {
  return candidate === changed || candidate.endsWith(`/${changed}`) || changed.endsWith(`/${candidate}`);
}

export interface HmrControllerOptions {
  readonly root: string;
  readonly units: readonly HmrUnit[];
  readonly readFile: FileReader;
  readonly build: (unit: HmrUnit, version: number, digest: string) => BuildArtifact | Promise<BuildArtifact>;
  readonly evaluate: (artifact: BuildArtifact) => UnitInstance | Promise<UnitInstance>;
  /** replace 由 controller 在 registry 中真实执行；apply 可用第三个参数重复触发同一替换。 */
  readonly apply: (
    unit: HmrUnit,
    instance: UnitInstance,
    replace?: () => void
  ) => void | Promise<void>;
  readonly classify?: (unit: HmrUnit, changed: readonly string[]) => SkipReason | undefined;
  /** critical root：apply 前先 shadow-apply，失败触发 compensate。 */
  readonly critical?: readonly string[];
  readonly shadowApply?: (unit: HmrUnit, instance: UnitInstance) => void | Promise<void>;
  readonly compensate?: (unit: HmrUnit, previous: HmrState | undefined) => void | Promise<void>;
  /** 真实 component registry：replace 保留 uid/parent/config，revision 递增。 */
  readonly registry?: ComponentRegistry<any>;
  readonly componentOf?: (unit: HmrUnit) => unknown;
  readonly replacementOf?: (unit: HmrUnit, instance: UnitInstance) => unknown;
  readonly auto?: boolean;
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface HmrController {
  readonly root: string;
  readonly strategy: "closure-digest-connected-unit";
  markDirty(files: readonly string[]): void;
  markDirtySigned(signatures: readonly FileSignature[]): void;
  /** auto watcher 入口：登记脏文件并防抖调度；flush 拒绝进入 errors 出口。 */
  notifyFile(file: string): void;
  flush(): Promise<HmrResult>;
  /** readiness barrier：等待本 controller 队列中此前登记的事务全部结束。 */
  ready(): Promise<void>;
  failed(): readonly string[];
  /** 自动调度的 flush 拒绝均落在此，不产生未处理 Promise。 */
  errors(): readonly unknown[];
  stateOf(id: string): HmrState | undefined;
  revisionOf(id: string): number;
  analysis(): GraphAnalysis;
  graph(): ImportGraph;
  close(): void;
}

/** 完整 HMR 事务：每次重建 import graph → 输入闭包 digest → 连通 unit → 快照 → build/evaluate → 同 fiber apply。 */
export function createHmrController(options: HmrControllerOptions): HmrController {
  const seen = new Set<string>();
  for (const unit of options.units) {
    if (seen.has(unit.id)) throw new Error("DUPLICATE_HMR_UNIT");
    seen.add(unit.id);
  }

  let graph = buildImportGraph(options.units.map((unit) => unit.entry), options.readFile);
  const critical = new Set(options.critical ?? []);
  const states = new Map<string, HmrState>();
  const failedUnits = new Set<string>();
  /** 失败单元的未交付变更根：重试必须围绕这些根，不因无关文件反复触发。 */
  const retainedRoots = new Map<string, Set<string>>();
  const errors: unknown[] = [];
  const dirty = new Set<string>();
  const queue = createHmrQueue();
  const pendingSignatures = new Map<string, string>();
  let fsWatcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let lastAnalysis: GraphAnalysis = EMPTY_ANALYSIS;

  const markDirty = (files: readonly string[]): void => {
    for (const file of files) dirty.add(normalizePath(file));
  };

  const recordError = (error: unknown): void => {
    errors.push(error);
    options.onError?.(error);
  };

  async function transaction(): Promise<HmrResult> {
    // 每次事务重建 graph：新增/删除 import 与环都基于当前文件内容，而非创建时的快照。
    graph = buildImportGraph(
      options.units.map((unit) => unit.entry),
      options.readFile
    );
    const newChanges = [...dirty];
    dirty.clear();
    const signed = new Map(pendingSignatures);
    pendingSignatures.clear();

    const result: {
      settled: string[];
      reused: string[];
      aborted: string[];
      skipped: string[];
      retried: string[];
      detail: {
        settled: HmrDetailEntry[];
        reused: HmrDetailEntry[];
        aborted: HmrDetailEntry[];
        skipped: HmrDetailEntry[];
      };
    } = {
      settled: [],
      reused: [],
      aborted: [],
      skipped: [],
      retried: [],
      detail: { settled: [], reused: [], aborted: [], skipped: [] },
    };
    const signatureCache = new Map<string, string>();
    const signatureOf = (file: string): string => {
      const cached = signatureCache.get(file);
      if (cached !== undefined) return cached;
      const content = options.readFile(file);
      const value = content === undefined ? digestText(file) : digestText(content);
      signatureCache.set(file, value);
      return value;
    };

    const tampered = new Set<string>();
    const tamperedUnits = new Set<string>();
    for (const [path, digest] of signed) {
      if (signatureOf(path) !== digest) {
        tampered.add(path);
        const matched = options.units.find((unit) => pathMatches(unit.entry, path));
        const id = matched?.id;
        if (id !== undefined && matched !== undefined && !tamperedUnits.has(id)) {
          tamperedUnits.add(id);
          const roots = closureOf(graph, matched.entry).filter((file) =>
            [...newChanges, ...tampered].some((path) => pathMatches(file, path))
          );
          retainedRoots.set(id, new Set(roots.length > 0 ? roots : [normalizePath(matched.entry)]));
          result.aborted.push(id);
          result.detail.aborted.push({
            id,
            reason: "signature-mismatch",
            error: new Error(`SIGNATURE_MISMATCH: ${path}`),
          });
        }
      }
    }

    const changedPaths = new Set([...newChanges, ...tampered]);
    if (changedPaths.size === 0) {
      // 无新文件时只重试此前失败且仍有未交付变更根的单元；不是任意 flush 都重试。
      for (const roots of retainedRoots.values()) for (const root of roots) changedPaths.add(root);
    }
    if (changedPaths.size === 0) return result;
    const hasNewChanges = newChanges.length > 0 || tampered.size > 0;
    const retain = (id: string, entry: string): void => {
      const roots = closureOf(graph, entry).filter((file) =>
        [...changedPaths].some((path) => pathMatches(file, path))
      );
      retainedRoots.set(id, new Set(roots.length > 0 ? roots : [normalizePath(entry)]));
    };
    const clearRetained = (id: string): void => {
      retainedRoots.delete(id);
    };

    lastAnalysis = analyzeGraph(
      graph,
      [...changedPaths],
      options.units.map((unit) => unit.entry),
      options.units.flatMap((unit) => [unit.entry, ...(unit.accepts ?? [])])
    );

    const partitionOfEntry = new Map<string, string>();
    lastAnalysis.partitions.forEach((group, index) => {
      for (const entry of group) partitionOfEntry.set(normalizePath(entry), `group:${index}`);
    });
    const partitionOf = (unit: HmrUnit): string =>
      partitionOfEntry.get(normalizePath(unit.entry)) ?? `solo:${unit.id}`;
    const members = new Map<string, string[]>();
    const targets: Array<{ unit: HmrUnit; retry: boolean; digest: string; partition: string }> = [];
    for (const unit of options.units) {
      if (tamperedUnits.has(unit.id)) continue;
      const closure = closureOf(graph, unit.entry);
      // 有新的变更时只看新 root；无新变更时只回放该失败单元自己的未交付 root。
      const retained = retainedRoots.get(unit.id);
      const stale = hasNewChanges
        ? closure.some((file) => [...changedPaths].some((path) => pathMatches(file, path))) ||
          (retained !== undefined &&
            [...retained].some((root) => [...changedPaths].some((path) => pathMatches(root, path))))
        : (retained?.size ?? 0) > 0;
      if (!stale) continue;
      const retry = failedUnits.has(unit.id);
      const digest = closureDigest(graph, unit.entry, {
        get: (file) => signatureCache.get(file) ?? signatureOf(file),
      } as ReadonlyMap<string, string>);
      const previous = states.get(unit.id);
      if (!retry && previous?.status === "ACTIVE" && previous.digest === digest) {
        result.reused.push(unit.id);
        result.detail.reused.push({ id: unit.id });
        continue;
      }
      const partition = partitionOf(unit);
      members.set(partition, [...(members.get(partition) ?? []), unit.id]);
      targets.push({ unit, retry, digest, partition });
    }

    const { backup } = snapshotAndBackup(
      targets.map((target) => target.unit),
      states
    );
    const candidates: Array<{
      unit: HmrUnit;
      state: HmrState;
      retry: boolean;
      previous: HmrState | undefined;
      partition: string;
    }> = [];
    const abortedIds: string[] = [];
    const skippedIds: string[] = [];
    const rolledBackIds = new Set<string>();
    const failedPartitions = new Set<string>();

    const abort = (id: string, error: unknown): void => {
      if (abortedIds.includes(id)) return;
      abortedIds.push(id);
      result.detail.aborted.push({ id, error });
    };
    const rollBackPartition = (partition: string, origin: string, error: unknown): void => {
      failedPartitions.add(partition);
      for (const id of members.get(partition) ?? []) {
        if (id === origin || abortedIds.includes(id) || rolledBackIds.has(id)) continue;
        rolledBackIds.add(id);
        abortedIds.push(id);
        result.detail.aborted.push({ id, error: new Error(`PARTITION_ROLLBACK: ${partition}`) });
      }
    };

    for (const { unit, retry, digest, partition } of targets) {
      const reason = options.classify?.(unit, [...changedPaths]);
      if (reason !== undefined) {
        result.skipped.push(unit.id);
        skippedIds.push(unit.id);
        result.detail.skipped.push({ id: unit.id, reason });
        continue;
      }
      const version = (states.get(unit.id)?.revision ?? 0) + 1;
      try {
        const artifact = await options.build(unit, version, digest);
        const instance = await options.evaluate(artifact);
        candidates.push({
          unit,
          retry,
          previous: states.get(unit.id),
          partition,
          state: { unit, revision: version, digest, artifact, instance, status: "ACTIVE" },
        });
      } catch (error) {
        abort(unit.id, error);
        rollBackPartition(partition, unit.id, error);
        retain(unit.id, unit.entry);
      }
    }

    const restoreIds = [...abortedIds, ...skippedIds, ...rolledBackIds, ...tamperedUnits];
    backup.restore([...new Set(restoreIds)]);
    for (const id of [...abortedIds, ...rolledBackIds, ...tamperedUnits]) failedUnits.add(id);
    for (const id of skippedIds) {
      failedUnits.delete(id);
      clearRetained(id);
    }

    const settled: typeof candidates = [];
    for (const candidate of candidates) {
      const { unit, state, retry, previous, partition } = candidate;
      if (failedPartitions.has(partition)) continue;
      const replace = (): void => {
        if (
          options.registry === undefined ||
          options.componentOf === undefined ||
          options.replacementOf === undefined
        ) {
          return;
        }
        options.registry.replace(
          options.componentOf(unit) as never,
          options.replacementOf(unit, state.instance) as never
        );
      };
      try {
        if (critical.has(unit.id) && options.shadowApply !== undefined) {
          await options.shadowApply(unit, state.instance);
        }
        replace();
        await options.apply(unit, state.instance, replace);
        states.set(unit.id, state);
        failedUnits.delete(unit.id);
        clearRetained(unit.id);
        settled.push(candidate);
      } catch (error) {
        // apply 失败留 FAILED 可观察；同连通分区已提交的其他 unit 一起回退旧 artifact。
        failedPartitions.add(partition);
        for (const applied of [...settled].reverse()) {
          if (applied.partition !== partition) continue;
          try {
            await options.compensate?.(applied.unit, applied.previous);
          } catch {
            // 补偿失败不覆盖原始 apply 错误。
          }
          backup.restore([applied.unit.id]);
        }
        for (let index = settled.length - 1; index >= 0; index -= 1) {
          if (settled[index]!.partition === partition) settled.splice(index, 1);
        }
        if (critical.has(unit.id)) {
          try {
            await options.compensate?.(unit, previous);
          } catch {
            // 同上。
          }
        }
        states.set(unit.id, { ...state, status: "FAILED", error });
        failedUnits.add(unit.id);
        retain(unit.id, unit.entry);
        rollBackPartition(partition, unit.id, error);
      }
    }

    result.aborted = [...new Set([...abortedIds, ...tamperedUnits])];
    result.settled = settled.map((item) => item.unit.id);
    result.detail.settled = settled.map((item) => ({ id: item.unit.id }));
    result.retried = settled.filter((item) => item.retry).map((item) => item.unit.id);
    return result;
  }

  function flush(): Promise<HmrResult> {
    return queue.run(transaction);
  }

  function scheduleFlush(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void flush().catch(recordError);
    }, options.debounceMs ?? 100);
  }

  const notifyFile = (file: string): void => {
    if (typeof file !== "string") return;
    markDirty([file]);
    scheduleFlush();
  };

  if (options.auto === true) {
    fsWatcher = fsWatch(options.root, (_event, filename) => notifyFile(filename as string));
  }

  return {
    root: options.root,
    strategy: "closure-digest-connected-unit",
    markDirty,
    markDirtySigned(signatures) {
      for (const signature of signatures) {
        const path = normalizePath(signature.path);
        pendingSignatures.set(path, signature.digest);
        dirty.add(path);
      }
    },
    notifyFile,
    flush,
    ready: async () => {
      await queue.ready();
    },
    failed: () => [...failedUnits].sort(),
    errors: () => [...errors],
    stateOf: (id) => states.get(id),
    revisionOf: (id) => states.get(id)?.revision ?? 0,
    analysis: () => lastAnalysis,
    graph: () => graph,
    close: () => {
      if (debounce) clearTimeout(debounce);
      fsWatcher?.close();
      fsWatcher = null;
    },
  };
}
