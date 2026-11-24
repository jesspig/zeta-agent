import { hashValue } from "./contract";

/** delta / pending 的品牌标记：外部无法伪造。 */
export declare const deltaBrand: unique symbol;
export declare const pendingBrand: unique symbol;

export type PathSegment = string | number;

/** 精确 op：set / delete / replace-root，按跟踪顺序排列。 */
export type DeltaOp =
  | readonly ["s", readonly PathSegment[], unknown]
  | readonly ["d", readonly PathSegment[]]
  | readonly ["r", unknown];

export interface Delta {
  readonly [deltaBrand]: true;
  /** 权威分配的全局递增序号，副本按此顺序应用。 */
  readonly seq: number;
  readonly ops: readonly DeltaOp[];
  readonly baseFingerprint: string;
  /** 产生该 delta 的代码/进程代次；跨代次消息必须被拒。 */
  readonly generation?: number;
}

export interface PendingDelta {
  readonly [pendingBrand]: true;
  readonly id: number;
  readonly ops: readonly DeltaOp[];
  readonly baseFingerprint: string;
  readonly stale: boolean;
}

export interface Tracker {
  readonly changes: number;
  readonly baseFingerprint: string;
  set(path: readonly PathSegment[], value: unknown): void;
  delete(path: readonly PathSegment[]): void;
  replaceRoot(value: unknown): void;
}

const TRACKER_OPS = new WeakMap<Tracker, DeltaOp[]>();
const PENDING_OPS = new WeakMap<PendingDelta, readonly DeltaOp[]>();
const DELTAS = new WeakSet<object>();
const PENDINGS = new WeakSet<object>();
const ALL_PENDING = new Set<PendingDelta>();
const STALE = new WeakSet<object>();

let pendingSeq = 0;
let deltaSeq = 0;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPath(path: readonly PathSegment[]): void {
  for (const segment of path) {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      throw new Error("UNSAFE_PATH");
    }
  }
}

function freezeOps(ops: readonly DeltaOp[]): readonly DeltaOp[] {
  return Object.freeze(ops.map((op) => Object.freeze([...op]) as DeltaOp));
}

export function track(base: unknown): Tracker {
  const ops: DeltaOp[] = [];
  const baseFingerprint = hashValue(base);
  const tracker = {
    get changes(): number {
      return ops.length;
    },
    baseFingerprint,
    set(path: readonly PathSegment[], value: unknown): void {
      assertPath(path);
      ops.push(["s", [...path], clone(value)]);
    },
    delete(path: readonly PathSegment[]): void {
      assertPath(path);
      ops.push(["d", [...path]]);
    },
    replaceRoot(value: unknown): void {
      ops.push(["r", clone(value)]);
    },
  } as Tracker;
  TRACKER_OPS.set(tracker, ops);
  return tracker;
}

export function prepare(tracker: Tracker): PendingDelta {
  const ops = TRACKER_OPS.get(tracker);
  if (ops === undefined || !TRACKER_OPS.has(tracker)) throw new Error("INVALID_TRACKER");
  const id = (pendingSeq += 1);
  const baseFingerprint = tracker.baseFingerprint;
  const frozen = freezeOps(ops);
  let self!: PendingDelta;
  const pending = {
    id,
    ops: frozen,
    baseFingerprint,
    get stale(): boolean {
      return STALE.has(self);
    },
  } as PendingDelta;
  self = pending;
  PENDINGS.add(pending);
  ALL_PENDING.add(pending);
  PENDING_OPS.set(pending, frozen);
  return Object.freeze(pending);
}

export function adopt(pending: PendingDelta, generation?: number): Delta {
  if (typeof pending !== "object" || pending === null || !PENDINGS.has(pending)) {
    throw new Error("INVALID_PENDING_DELTA");
  }
  for (const other of ALL_PENDING) {
    if (other !== pending && other.baseFingerprint === pending.baseFingerprint) {
      STALE.add(other);
    }
  }
  const ops = PENDING_OPS.get(pending);
  if (ops === undefined) throw new Error("INVALID_PENDING_DELTA");
  const delta = {
    seq: (deltaSeq += 1),
    ops,
    baseFingerprint: pending.baseFingerprint,
    ...(generation === undefined ? {} : { generation }),
  } as Delta;
  DELTAS.add(delta);
  return Object.freeze(delta);
}

function applyAt(root: unknown, path: readonly PathSegment[], value: unknown, remove: boolean): unknown {
  const head = path[0];
  if (head === undefined) return remove ? undefined : value;
  const isArray = Array.isArray(root);
  const source: unknown[] | Record<string, unknown> =
    root !== null && typeof root === "object" ? (root as unknown[] | Record<string, unknown>) : {};
  const key = String(head);
  const container: unknown[] | Record<string, unknown> = isArray
    ? [...(source as unknown[])]
    : { ...(source as Record<string, unknown>) };
  if (path.length === 1) {
    if (remove) {
      if (isArray) (container as unknown[]).splice(Number(head), 1);
      else delete (container as Record<string, unknown>)[key];
    } else {
      (container as Record<string, unknown>)[key] = value;
    }
  } else {
    (container as Record<string, unknown>)[key] = applyAt(
      (source as Record<string, unknown>)[key],
      path.slice(1),
      value,
      remove
    );
  }
  return container;
}

/** 不可变应用：全程深拷贝，结果不与输入共享任何可变对象；op 按序执行。 */
export function applyImmutable<T>(root: T, delta: Delta): T {
  if (typeof delta !== "object" || delta === null || !DELTAS.has(delta)) {
    throw new Error("INVALID_DELTA");
  }
  let current: unknown = clone(root);
  for (const op of delta.ops) {
    if (op[0] === "r") {
      current = clone(op[1]);
      continue;
    }
    const path = op[1];
    assertPath(path);
    const value = op[0] === "s" ? clone(op[2]) : undefined;
    if (path.length === 0) {
      current = value;
    } else {
      current = applyAt(current, path, value, op[0] === "d");
    }
  }
  return current as T;
}

export type StaleReason = "FINGERPRINT" | "SEQ" | "GENERATION";

/** 副本应用了不属于当前权威基线的 delta：FAILED，不覆写本地状态。 */
export class StaleDeltaError extends Error {
  readonly kind = "STALE" as const;
  readonly reason: StaleReason;

  constructor(reason: StaleReason, message: string) {
    super(message);
    this.name = "StaleDeltaError";
    this.reason = reason;
  }
}

export interface BaselineOptions {
  readonly seq?: number;
  readonly generation?: number;
}

/** 权威基线：值 + 指纹 + 全局 seq + 代次；只接受严格其后继且指纹/代次一致。 */
export interface Baseline<T> {
  readonly value: T;
  readonly fingerprint: string;
  readonly seq: number;
  readonly generation?: number;
  apply(delta: Delta, expectedGeneration?: number): Baseline<T>;
}

function makeBaseline<T>(value: T, fingerprint: string, seq: number, generation?: number): Baseline<T> {
  return Object.freeze({
    value,
    fingerprint,
    seq,
    ...(generation === undefined ? {} : { generation }),
    apply(next: Delta, expectedGeneration?: number): Baseline<T> {
      if (typeof next !== "object" || next === null || !DELTAS.has(next)) {
        throw new Error("INVALID_DELTA");
      }
      if (next.seq <= seq) {
        throw new StaleDeltaError("SEQ", `delta seq ${next.seq} 不晚于当前 seq ${seq}`);
      }
      if (next.baseFingerprint !== fingerprint) {
        throw new StaleDeltaError("FINGERPRINT", "delta 基线指纹不等于当前权威指纹");
      }
      const expected = expectedGeneration ?? generation;
      if (expected !== undefined && next.generation !== expected) {
        throw new StaleDeltaError("GENERATION", `delta 代次 ${next.generation} 不是当前代次 ${expected}`);
      }
      const applied = applyImmutable(value, next) as T;
      return makeBaseline(applied, hashValue(applied), next.seq, generation);
    },
  });
}

export function baseline<T>(value: T, options: BaselineOptions = {}): Baseline<T> {
  return makeBaseline(clone(value), hashValue(value), options.seq ?? 0, options.generation);
}
