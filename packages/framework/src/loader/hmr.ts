import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { watch as fsWatch, type FSWatcher } from "node:fs";

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
}

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

  // 连通分区：两个入口的闭包若共享任一 declined 模块，则必须同一事务提交。
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
  };
}

export type HmrStatus = "ACTIVE" | "FAILED";
export type SkipReason = "host-module" | "native-addon" | "ambiguous-import" | "ambiguous-export" | "signature-mismatch";

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

const inTransaction = new AsyncLocalStorage<boolean>();
let queueTail: Promise<unknown> = Promise.resolve();

/** 单一事务队列：拒绝嵌套，保证 readiness barrier 可等待全部在途事务。 */
export function runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  if (inTransaction.getStore() === true) return Promise.reject(new Error("HMR_NESTED"));
  const run = (): Promise<T> => inTransaction.run(true, async () => await fn());
  const result = queueTail.then(run, run);
  queueTail = result.then(() => undefined, () => undefined);
  return result;
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
  readonly apply: (unit: HmrUnit, instance: UnitInstance) => void | Promise<void>;
  readonly classify?: (unit: HmrUnit, changed: readonly string[]) => SkipReason | undefined;
  /** critical root：apply 前先 shadow-apply，失败触发 compensate。 */
  readonly critical?: readonly string[];
  readonly shadowApply?: (unit: HmrUnit, instance: UnitInstance) => void | Promise<void>;
  readonly compensate?: (unit: HmrUnit, previous: HmrState | undefined) => void | Promise<void>;
  readonly auto?: boolean;
  readonly debounceMs?: number;
}

export interface HmrController {
  readonly root: string;
  readonly strategy: "closure-digest-connected-unit";
  markDirty(files: readonly string[]): void;
  markDirtySigned(signatures: readonly FileSignature[]): void;
  flush(): Promise<HmrResult>;
  /** readiness barrier：等待队列中此前登记的事务全部结束。 */
  ready(): Promise<void>;
  failed(): readonly string[];
  stateOf(id: string): HmrState | undefined;
  revisionOf(id: string): number;
  analysis(): GraphAnalysis;
  close(): void;
}

/** 完整 HMR 事务：输入闭包 digest → 连通 unit → 快照 → build/evaluate → 同 fiber apply。 */
export function createHmrController(options: HmrControllerOptions): HmrController {
  const seen = new Set<string>();
  for (const unit of options.units) {
    if (seen.has(unit.id)) throw new Error("DUPLICATE_HMR_UNIT");
    seen.add(unit.id);
  }

  const graph = buildImportGraph(
    options.units.map((unit) => unit.entry),
    options.readFile
  );
  const critical = new Set(options.critical ?? []);
  const states = new Map<string, HmrState>();
  const failedUnits = new Set<string>();
  const dirty = new Set<string>();
  const pendingSignatures = new Map<string, string>();
  let fsWatcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let lastAnalysis: GraphAnalysis = { accepted: [], declined: [], partitions: [] };

  const markDirty = (files: readonly string[]): void => {
    for (const file of files) dirty.add(normalizePath(file));
  };

  async function transaction(): Promise<HmrResult> {
    const changed = [...dirty];
    dirty.clear();
    const signed = new Map(pendingSignatures);
    pendingSignatures.clear();

    const result: HmrResult = {
      settled: [], reused: [], aborted: [], skipped: [], retried: [],
      detail: { settled: [], reused: [], aborted: [], skipped: [] },
    };
    if (changed.length === 0 && failedUnits.size === 0) return result;

    const signatureCache = new Map<string, string>();
    const signatureOf = (file: string): string => {
      const cached = signatureCache.get(file);
      if (cached !== undefined) return cached;
      const content = options.readFile(file);
      const value = content === undefined ? digestText(file) : digestText(content);
      signatureCache.set(file, value);
      return value;
    };

    // 文件签名：登记签名须与真实内容一致，否则相关 unit abort（不污染旧状态）。
    const tampered = new Set<string>();
    const tamperedUnits = new Set<string>();
    for (const [path, digest] of signed) {
      if (signatureOf(path) !== digest) {
        tampered.add(path);
        const id = options.units.find((unit) => pathMatches(unit.entry, path))?.id;
        if (id !== undefined && !tamperedUnits.has(id)) {
          tamperedUnits.add(id);
          result.aborted.push(id);
          result.detail.aborted.push({
            id,
            reason: "signature-mismatch",
            error: new Error(`SIGNATURE_MISMATCH: ${path}`),
          });
        }
      }
    }

    const changedPaths = new Set([...changed, ...tampered]);
    lastAnalysis = analyzeGraph(
      graph,
      [...changedPaths],
      options.units.map((unit) => unit.entry),
      options.units.flatMap((unit) => [unit.entry, ...(unit.accepts ?? [])])
    );

    const targets: Array<{ unit: HmrUnit; retry: boolean; digest: string }> = [];
    for (const unit of options.units) {
      if (tamperedUnits.has(unit.id)) continue;
      const closure = closureOf(graph, unit.entry);
      const stale = closure.some((file) => [...changedPaths].some((changedPath) => pathMatches(file, changedPath)));
      const retry = failedUnits.has(unit.id);
      if (!stale && !retry) continue;
      const digest = closureDigest(graph, unit.entry, {
        get: (file) => signatureCache.get(file) ?? signatureOf(file),
      } as ReadonlyMap<string, string>);
      const previous = states.get(unit.id);
      if (!retry && previous?.status === "ACTIVE" && previous.digest === digest) {
        result.reused.push(unit.id);
        result.detail.reused.push({ id: unit.id });
        continue;
      }
      targets.push({ unit, retry, digest });
    }

    const { snapshot, backup } = snapshotAndBackup(targets.map((target) => target.unit), states);
    const candidates: Array<{
      unit: HmrUnit;
      state: HmrState;
      retry: boolean;
      previous: HmrState | undefined;
    }> = [];
    const abortedIds: string[] = [];
    const skippedIds: string[] = [];

    for (const { unit, retry, digest } of targets) {
      const reason = options.classify?.(unit, [...changed]);
      if (reason !== undefined) {
        result.skipped.push(unit.id);
        skippedIds.push(unit.id);
        result.detail.skipped.push({ id: unit.id, reason });
        continue;
      }
      const version = snapshot.get(unit.id)!.revision;
      try {
        const artifact = await options.build(unit, version, digest);
        const instance = await options.evaluate(artifact);
        candidates.push({
          unit,
          retry,
          previous: states.get(unit.id),
          state: { unit, revision: version, digest, artifact, instance, status: "ACTIVE" },
        });
      } catch (error) {
        result.aborted.push(unit.id);
        abortedIds.push(unit.id);
        result.detail.aborted.push({ id: unit.id, error });
      }
    }

    backup.restore([...abortedIds, ...skippedIds, ...tamperedUnits]);
    for (const id of [...abortedIds, ...tamperedUnits]) failedUnits.add(id);
    for (const id of skippedIds) failedUnits.delete(id);

    for (const { unit, state, retry, previous } of candidates) {
      try {
        if (critical.has(unit.id) && options.shadowApply !== undefined) {
          await options.shadowApply(unit, state.instance);
        }
        await options.apply(unit, state.instance);
        states.set(unit.id, state);
        failedUnits.delete(unit.id);
        result.settled.push(unit.id);
        result.detail.settled.push({ id: unit.id });
        if (retry) result.retried.push(unit.id);
      } catch (error) {
        if (critical.has(unit.id)) {
          try {
            await options.compensate?.(unit, previous);
          } catch {
            // 补偿失败不覆盖原始 apply 错误；状态仍为 FAILED。
          }
        }
        states.set(unit.id, { ...state, status: "FAILED", error });
        failedUnits.add(unit.id);
      }
    }
    return result;
  }

  if (options.auto === true) {
    fsWatcher = fsWatch(options.root, (_event, filename) => {
      if (typeof filename !== "string") return;
      markDirty([filename]);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void flush(), options.debounceMs ?? 100);
    });
  }

  function flush(): Promise<HmrResult> {
    return runExclusive(transaction);
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
    flush,
    ready: async () => {
      await queueTail;
    },
    failed: () => [...failedUnits].sort(),
    stateOf: (id) => states.get(id),
    revisionOf: (id) => states.get(id)?.revision ?? 0,
    analysis: () => lastAnalysis,
    close: () => {
      if (debounce) clearTimeout(debounce);
      fsWatcher?.close();
      fsWatcher = null;
    },
  };
}
