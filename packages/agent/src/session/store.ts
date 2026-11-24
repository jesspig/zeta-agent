import type { AgentMessage, CompactionLineage, SemanticRecap } from "@zeta-agent/agent-framework";

export const SESSION_STORE_FORMAT = "zeta-session-store" as const;
export const SESSION_STORE_VERSION = 1 as const;

export type SessionFrameKind = "message" | "recap" | "fork" | "truncate";

interface SessionFrameBase {
  readonly id: string;
  readonly seq: number;
  readonly parentId: string | null;
  readonly createdAt: string;
}

export type SessionFrame =
  | (SessionFrameBase & { readonly kind: "message"; readonly message: AgentMessage })
  | (SessionFrameBase & {
      readonly kind: "recap";
      readonly recap: SemanticRecap;
      readonly uris: readonly string[];
      readonly lineage: CompactionLineage;
    })
  | (SessionFrameBase & { readonly kind: "fork"; readonly fromId: string | null })
  | (SessionFrameBase & { readonly kind: "truncate"; readonly fromId: string | null });

export interface SessionHeader {
  readonly format: typeof SESSION_STORE_FORMAT;
  readonly version: number;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface SessionLease {
  readonly owner: string;
  readonly expiresAt: number;
}

export type SessionStoreState = "ready" | "unknown-outcome" | "readonly";

export interface AppendReceipt {
  readonly frameId: string;
  readonly seq: number;
  readonly outcome: "committed";
}

export interface PendingIntent {
  readonly id: string;
  readonly frame: SessionFrame;
}

export interface RecoveryResult {
  readonly state: SessionStoreState;
  readonly committed: readonly string[];
  readonly retryable: readonly string[];
  readonly badLines: number;
}

export interface ProjectionOptions {
  readonly fromId?: string;
}

export interface SessionProjection {
  readonly frames: readonly SessionFrame[];
  readonly branch: readonly SessionFrame[];
  readonly messages: readonly AgentMessage[];
  readonly lineage: readonly CompactionLineage[];
  readonly markers: readonly SessionFrame[];
  readonly leafId: string | null;
  readonly badLines: number;
}

/** 崩溃窗口故障注入：pending 落盘前、frame 提交前、frame 提交后各一个切点。 */
export interface SessionStoreFaults {
  beforeCommit?: (batch: readonly SessionFrame[]) => void | Promise<void>;
  duringCommit?: (batch: readonly SessionFrame[]) => void | Promise<void>;
  afterCommit?: (batch: readonly SessionFrame[]) => void | Promise<void>;
}

export type SessionStoreErrorCode =
  | "SESSION_RETRYABLE"
  | "SESSION_UNKNOWN_OUTCOME"
  | "SESSION_STATE_UNKNOWN_OUTCOME"
  | "SESSION_READONLY"
  | "SESSION_LEASE_BUSY"
  | "SESSION_FRAME_NOT_FOUND"
  | "SESSION_INVALID_FRAME"
  | "SESSION_CLOSED";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

export interface RecapOptions {
  readonly threshold?: number;
  readonly preTokenCount?: number;
}

export interface SessionStoreOptions {
  readonly path: string;
  readonly sessionId?: string;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly faults?: SessionStoreFaults;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly migrated: boolean;
}

/**
 * IF-09 的公共契约。两种后端共享 header/version/append/projection/resume/
 * fork/truncate/clone/recover 语义；写入只允许追加不可变 frame。
 */
export interface SessionStore {
  readonly header: SessionHeader;
  readonly version: number;
  readonly state: SessionStoreState;
  readonly sessionId: string;
  append(message: AgentMessage): Promise<AppendReceipt>;
  appendRecap(recap: SemanticRecap, uris: readonly string[], options?: RecapOptions): Promise<AppendReceipt>;
  projection(options?: ProjectionOptions): SessionProjection;
  /** 在指定 frame 上恢复可写视图，不写 marker，也不改原历史。 */
  resume(frameId: string): SessionStore;
  /** 追加独立 fork marker；marker 不进入 lineage。 */
  fork(fromId?: string): Promise<SessionStore>;
  /** 追加 truncate marker，活跃分支前移到指定 frame，历史 frame 不可变。 */
  truncate(frameId: string): Promise<SessionStore>;
  /** 复制为独立存储并重新映射 frame id 与 parentId。 */
  clone(destination: string): SessionStore;
  recover(): Promise<RecoveryResult>;
  lease(): SessionLease | undefined;
  pendingIntents(): readonly PendingIntent[];
  migrate(): MigrationResult;
  close(): void;
}

let idCounter = 0;
export function createFrameId(): string {
  idCounter += 1;
  return `f-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createHeader(sessionId: string, createdAt: string, version = SESSION_STORE_VERSION): SessionHeader {
  return { format: SESSION_STORE_FORMAT, version, sessionId, createdAt };
}

export function isSessionFrame(value: unknown): value is SessionFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.id === "string" &&
    typeof frame.seq === "number" &&
    (frame.parentId === null || typeof frame.parentId === "string") &&
    typeof frame.createdAt === "string" &&
    (frame.kind === "message" || frame.kind === "recap" || frame.kind === "fork" || frame.kind === "truncate")
  );
}

export function assertSessionFrame(value: unknown): asserts value is SessionFrame {
  if (!isSessionFrame(value)) throw new SessionStoreError("SESSION_INVALID_FRAME", "INVALID_SESSION_FRAME");
}

/** 从 leaf 回溯 parentId 得到活跃分支；lineage/fork marker 从全量 frame 统计。 */
export function projectSessionFrames(
  frames: readonly SessionFrame[],
  options: ProjectionOptions & { readonly badLines?: number } = {}
): SessionProjection {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const startId = options.fromId ?? frames.at(-1)?.id ?? null;
  const branch: SessionFrame[] = [];
  const seen = new Set<string>();
  let cursor = startId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const frame = byId.get(cursor);
    if (frame === undefined) break;
    branch.push(frame);
    cursor = frame.parentId;
  }
  branch.reverse();
  return {
    frames: [...frames],
    branch,
    messages: branch.flatMap((frame) => (frame.kind === "message" ? [frame.message] : [])),
    lineage: frames.flatMap((frame) => (frame.kind === "recap" ? [frame.lineage] : [])),
    markers: frames.filter((frame) => frame.kind === "fork" || frame.kind === "truncate"),
    leafId: branch.at(-1)?.id ?? null,
    badLines: options.badLines ?? 0,
  };
}

/** 进程内按存储路径串行化 append/recover；跨进程由各后端的 lease 负责。 */
const pathLocks = new Map<string, Promise<void>>();

export async function withPathLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  pathLocks.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    void chained.then(() => {
      if (pathLocks.get(key) === chained) pathLocks.delete(key);
    });
  }
}
