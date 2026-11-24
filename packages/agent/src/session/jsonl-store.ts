import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { CompactionLineage, SemanticRecap } from "@zeta-agent/agent-framework";
import {
  assertSessionFrame,
  createFrameId,
  createHeader,
  isSessionFrame,
  projectSessionFrames,
  SESSION_STORE_VERSION,
  SessionStoreError,
  withPathLock,
  type AppendReceipt,
  type MigrationResult,
  type PendingIntent,
  type RecapOptions,
  type RecoveryResult,
  type SessionFrame,
  type SessionHeader,
  type SessionLease,
  type SessionProjection,
  type SessionStore,
  type SessionStoreOptions,
  type SessionStoreState,
} from "./store";

type JsonlRecord =
  | { readonly type: "header"; readonly header: SessionHeader }
  | { readonly type: "frame"; readonly frame: SessionFrame }
  | { readonly type: "pending"; readonly id: string; readonly frame: SessionFrame }
  | { readonly type: "ack"; readonly id: string }
  | { readonly type: "cancel"; readonly id: string };

interface JsonlSnapshot {
  header: SessionHeader | undefined;
  frames: SessionFrame[];
  pending: PendingIntent[];
  acks: Set<string>;
  cancelled: Set<string>;
  badLines: number;
  legacy: boolean;
}

function emptySnapshot(): JsonlSnapshot {
  return { header: undefined, frames: [], pending: [], acks: new Set(), cancelled: new Set(), badLines: 0, legacy: false };
}

function isLegacyFrame(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    (value.kind === "message" || value.kind === "recap" || value.kind === "fork" || value.kind === "truncate") &&
    typeof value.seq !== "number"
  );
}

function parseJsonl(text: string): JsonlSnapshot {
  const snapshot: JsonlSnapshot = emptySnapshot();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      snapshot.badLines += 1;
      continue;
    }
    if (typeof value !== "object" || value === null) {
      snapshot.badLines += 1;
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "header") {
      const header = record.header as SessionHeader | undefined;
      if (header === undefined || typeof header.version !== "number" || typeof header.sessionId !== "string") {
        snapshot.badLines += 1;
        continue;
      }
      snapshot.header = header;
    } else if (record.type === "frame" || record.type === "pending") {
      const frame = record.frame;
      if (!isSessionFrame(frame)) {
        snapshot.badLines += 1;
        continue;
      }
      if (record.type === "frame") snapshot.frames.push(frame);
      else if (typeof record.id === "string") snapshot.pending.push({ id: record.id, frame });
      else snapshot.badLines += 1;
    } else if (record.type === "ack") {
      if (typeof record.id === "string") snapshot.acks.add(record.id);
      else snapshot.badLines += 1;
    } else if (record.type === "cancel") {
      if (typeof record.id === "string") snapshot.cancelled.add(record.id);
      else snapshot.badLines += 1;
    } else if (isSessionFrame(record) || isLegacyFrame(record)) {
      snapshot.legacy = true;
      snapshot.frames.push(record as unknown as SessionFrame);
    } else {
      snapshot.badLines += 1;
    }
  }
  return snapshot;
}

function serializeRecords(records: readonly JsonlRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function appendRecord(path: string, record: JsonlRecord): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function toCurrentFrame(frame: SessionFrame, seq: number, createdAt: string): SessionFrame {
  const base = {
    id: frame.id,
    seq,
    parentId: frame.parentId ?? null,
    createdAt,
  };
  if (frame.kind === "message") return { ...base, kind: "message", message: frame.message };
  if (frame.kind === "recap") {
    const recap: SemanticRecap = frame.recap;
    const lineage: CompactionLineage =
      frame.lineage ?? { threshold: 0, recap, uris: [...(frame.uris ?? [])], preTokenCount: 0 };
    return { ...base, kind: "recap", recap, uris: [...(frame.uris ?? [])], lineage };
  }
  return { ...base, kind: frame.kind, fromId: frame.fromId ?? frame.parentId ?? null };
}

export interface MigrateSessionJsonlResult {
  readonly header: SessionHeader;
  readonly frames: readonly SessionFrame[];
  readonly badLines: number;
  readonly migrated: boolean;
}

/** 纯迁移函数：v0 裸 frame 行升级为 v1 header + frame；坏行不参与迁移。 */
export function migrateSessionJsonl(text: string, sessionId = "zeta-session"): MigrateSessionJsonlResult {
  const snapshot = parseJsonl(text);
  const createdAt = snapshot.header?.createdAt ?? new Date(0).toISOString();
  const header = createHeader(snapshot.header?.sessionId ?? sessionId, createdAt);
  const frames = snapshot.frames.map((frame, index) => toCurrentFrame(frame, index + 1, createdAt));
  return {
    header,
    frames,
    badLines: snapshot.badLines,
    migrated: snapshot.header === undefined || snapshot.header.version < SESSION_STORE_VERSION || snapshot.legacy,
  };
}

export interface JsonlSessionStoreOptions extends SessionStoreOptions {
  readonly rootFrameId?: string;
}

interface LoadedJsonl {
  readonly header: SessionHeader;
  readonly snapshot: JsonlSnapshot;
  readonly state: SessionStoreState;
}

export function createJsonlSessionStore(options: JsonlSessionStoreOptions): SessionStore {
  const path = resolve(options.path);
  const leasePath = `${path}.lease`;
  const leaseOwner = options.leaseOwner ?? `${process.pid}:${createFrameId()}`;
  const leaseTtlMs = options.leaseTtlMs ?? 2_000;
  const retryMs = options.retryMs ?? 500;
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? createFrameId;
  const createdAt = (): string => new Date(now()).toISOString();
  const defaultSessionId = options.sessionId ?? "zeta-session";
  let currentLease: SessionLease | undefined;
  let closed = false;
  let leafId: string | null = options.rootFrameId ?? null;

  function readSnapshot(): JsonlSnapshot {
    return existsSync(path) ? parseJsonl(readFileSync(path, "utf8")) : emptySnapshot();
  }

  function classify(snapshot: JsonlSnapshot, fallbackHeader: SessionHeader): LoadedJsonl {
    const header = snapshot.header ?? fallbackHeader;
    if (header.version > SESSION_STORE_VERSION) return { header, snapshot, state: "readonly" };
    const unresolved = snapshot.pending.some(
      (intent) => !snapshot.acks.has(intent.id) && !snapshot.cancelled.has(intent.id)
    );
    return { header, snapshot, state: unresolved ? "unknown-outcome" : "ready" };
  }

  function writeMigrated(sessionId: string): SessionHeader {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const migrated = migrateSessionJsonl(text, sessionId);
    const original = parseJsonl(text);
    atomicWrite(
      path,
      serializeRecords([
        { type: "header", header: migrated.header },
        ...migrated.frames.map((frame) => ({ type: "frame" as const, frame })),
        ...original.pending.map((intent) => ({ type: "pending" as const, id: intent.id, frame: intent.frame })),
        ...[...original.acks].map((id) => ({ type: "ack" as const, id })),
        ...[...original.cancelled].map((id) => ({ type: "cancel" as const, id })),
      ])
    );
    return migrated.header;
  }

  function load(): LoadedJsonl {
    const snapshot = readSnapshot();
    const fallback = createHeader(defaultSessionId, createdAt());
    if (snapshot.header !== undefined && snapshot.header.version > SESSION_STORE_VERSION) {
      return { header: snapshot.header, snapshot, state: "readonly" };
    }
    if (snapshot.header === undefined || snapshot.header.version < SESSION_STORE_VERSION || snapshot.legacy) {
      return classify(readSnapshot(), writeMigrated(defaultSessionId));
    }
    return classify(snapshot, snapshot.header);
  }

  const versionAtOpen = readSnapshot().header?.version ?? 0;
  let loaded = load();

  function refresh(): void {
    if (closed) return;
    loaded = classify(readSnapshot(), loaded.header);
  }

  function currentState(): SessionStoreState {
    refresh();
    return loaded.state;
  }

  function assertWritable(): void {
    if (closed) throw new SessionStoreError("SESSION_CLOSED", "SessionStore 已关闭");
    const current = currentState();
    if (current === "readonly") {
      throw new SessionStoreError("SESSION_READONLY", "存储版本不受支持，保持只读");
    }
    if (current === "unknown-outcome") {
      throw new SessionStoreError("SESSION_STATE_UNKNOWN_OUTCOME", "未知写入结果，须先 recover()");
    }
  }

  async function acquireLease(): Promise<SessionLease> {
    const deadline = now() + retryMs;
    for (;;) {
      try {
        const fd = openSync(leasePath, "wx");
        const lease: SessionLease = { owner: leaseOwner, expiresAt: now() + leaseTtlMs };
        try {
          writeSync(fd, JSON.stringify(lease));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        currentLease = lease;
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new SessionStoreError("SESSION_RETRYABLE", `租约获取失败：${String(error)}`);
        }
        let existing: SessionLease | undefined;
        try {
          existing = JSON.parse(readFileSync(leasePath, "utf8")) as SessionLease;
        } catch {
          existing = undefined;
        }
        if (existing !== undefined && typeof existing.expiresAt === "number" && now() > existing.expiresAt) {
          rmSync(leasePath, { force: true });
          continue;
        }
        if (now() > deadline) {
          throw new SessionStoreError("SESSION_LEASE_BUSY", "租约被其他写入者持有");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
  }

  function releaseLease(): void {
    rmSync(leasePath, { force: true });
    currentLease = undefined;
  }

  async function commit(batch: readonly SessionFrame[]): Promise<void> {
    const pendingId = idFactory();
    try {
      appendRecord(path, { type: "pending", id: pendingId, frame: batch[0]! });
    } catch (error) {
      throw new SessionStoreError("SESSION_RETRYABLE", `pending 写入失败：${String(error)}`);
    }
    try {
      await options.faults?.beforeCommit?.(batch);
    } catch (error) {
      // frame 尚未写入：确定性 retryable，记录 cancel 供恢复统计。
      appendRecord(path, { type: "cancel", id: pendingId });
      throw new SessionStoreError("SESSION_RETRYABLE", `提交前失败：${String(error)}`);
    }
    try {
      await options.faults?.duringCommit?.(batch);
      for (const frame of batch) appendRecord(path, { type: "frame", frame });
      await options.faults?.afterCommit?.(batch);
      appendRecord(path, { type: "ack", id: pendingId });
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("SESSION_UNKNOWN_OUTCOME", `提交结果未知：${String(error)}`);
    }
  }

  function nextSeq(): number {
    return loaded.snapshot.frames.reduce((max, frame) => Math.max(max, frame.seq), 0) + 1;
  }

  function buildFrame(kind: SessionFrame["kind"], parentId: string | null, extras: Record<string, unknown>): SessionFrame {
    const frame = { id: idFactory(), seq: nextSeq(), parentId, createdAt: createdAt(), kind, ...extras };
    assertSessionFrame(frame);
    return frame;
  }

  function rootId(): string | null {
    return leafId ?? loaded.snapshot.frames.at(-1)?.id ?? null;
  }

  async function appendFrame(frame: SessionFrame, advanceLeaf = true): Promise<AppendReceipt> {
    let committedFrame = frame;
    await withPathLock(path, async () => {
      assertWritable();
      await acquireLease();
      try {
        refresh();
        // seq 与 parentId 必须在锁内解析，否则并发 append 会共用同一序号或父节点。
        committedFrame = {
          ...frame,
          seq: nextSeq(),
          parentId: advanceLeaf ? rootId() : frame.parentId,
        };
        await commit([committedFrame]);
        if (advanceLeaf) leafId = committedFrame.id;
      } finally {
        releaseLease();
        refresh();
        // 提交后未收到 ack 的 frame 已在盘上，投影应能看到它。
        if (
          advanceLeaf &&
          loaded.snapshot.frames.some((item) => item.id === committedFrame.id)
        ) {
          leafId = committedFrame.id;
        }
      }
    });
    return { frameId: committedFrame.id, seq: committedFrame.seq, outcome: "committed" };
  }

  async function appendMarker(kind: "fork" | "truncate", parentId: string, fromId: string | null): Promise<string> {
    const receipt = await appendFrame(buildFrame(kind, parentId, { fromId }), false);
    return receipt.frameId;
  }

  function view(rootFrameId: string): SessionStore {
    return createJsonlSessionStore({ ...options, rootFrameId, idFactory, leaseOwner });
  }

  const store: SessionStore = {
    get header() {
      refresh();
      return loaded.header;
    },
    get version() {
      return this.header.version;
    },
    get state() {
      return currentState();
    },
    get sessionId() {
      return this.header.sessionId;
    },
    append(message) {
      return appendFrame(buildFrame("message", rootId(), { message }));
    },
    appendRecap(recap, uris, recapOptions?: RecapOptions) {
      const lineage: CompactionLineage = {
        threshold: recapOptions?.threshold ?? 0,
        recap,
        uris: [...uris],
        preTokenCount: recapOptions?.preTokenCount ?? 0,
      };
      return appendFrame(buildFrame("recap", rootId(), { recap, uris: [...uris], lineage }));
    },
    projection(projOptions?: { readonly fromId?: string }): SessionProjection {
      refresh();
      const fromId = projOptions?.fromId ?? leafId ?? undefined;
      return projectSessionFrames(loaded.snapshot.frames, {
        ...(fromId === undefined ? {} : { fromId }),
        badLines: loaded.snapshot.badLines,
      });
    },
    resume(frameId) {
      refresh();
      if (!loaded.snapshot.frames.some((frame) => frame.id === frameId)) {
        throw new SessionStoreError("SESSION_FRAME_NOT_FOUND", `frame 不存在：${frameId}`);
      }
      return view(frameId);
    },
    async fork(fromId) {
      refresh();
      const parentId = fromId ?? rootId();
      const markerId = await appendMarker("fork", parentId ?? "", parentId);
      return view(markerId);
    },
    async truncate(frameId) {
      refresh();
      if (!loaded.snapshot.frames.some((frame) => frame.id === frameId)) {
        throw new SessionStoreError("SESSION_FRAME_NOT_FOUND", `frame 不存在：${frameId}`);
      }
      const markerId = await appendMarker("truncate", frameId, frameId);
      return view(markerId);
    },
    clone(destination) {
      refresh();
      const target = resolve(destination);
      if (target === path) throw new SessionStoreError("SESSION_INVALID_FRAME", "clone 目的地不能与源相同");
      const idMap = new Map<string, string>();
      for (const frame of loaded.snapshot.frames) idMap.set(frame.id, idFactory());
      const clonedFrames = loaded.snapshot.frames.map((frame, index) => {
        const base = {
          id: idMap.get(frame.id)!,
          seq: index + 1,
          parentId: frame.parentId === null ? null : (idMap.get(frame.parentId) ?? null),
          createdAt: createdAt(),
        };
        if (frame.kind === "message") return { ...base, kind: "message", message: frame.message } as SessionFrame;
        if (frame.kind === "recap") {
          return { ...base, kind: "recap", recap: frame.recap, uris: frame.uris, lineage: frame.lineage } as SessionFrame;
        }
        return { ...base, kind: frame.kind, fromId: frame.fromId } as SessionFrame;
      });
      const header = createHeader(loaded.header.sessionId, createdAt());
      atomicWrite(
        target,
        serializeRecords([
          { type: "header", header },
          ...clonedFrames.map((frame) => ({ type: "frame" as const, frame })),
        ])
      );
      return createJsonlSessionStore({ ...options, path: target, rootFrameId: clonedFrames.at(-1)?.id });
    },
    async recover(): Promise<RecoveryResult> {
      if (closed) throw new SessionStoreError("SESSION_CLOSED", "SessionStore 已关闭");
      return withPathLock(path, async () => {
        await acquireLease();
        try {
          const snapshot = readSnapshot();
          const committed: string[] = [];
          const retryable: string[] = [];
          const frameIds = new Set(snapshot.frames.map((frame) => frame.id));
          for (const intent of snapshot.pending) {
            if (snapshot.acks.has(intent.id) || snapshot.cancelled.has(intent.id)) {
              if (snapshot.cancelled.has(intent.id)) retryable.push(intent.frame.id);
              continue;
            }
            if (frameIds.has(intent.frame.id)) committed.push(intent.frame.id);
            else retryable.push(intent.frame.id);
            appendRecord(path, { type: "ack", id: intent.id });
          }
          if (snapshot.badLines > 0 || snapshot.legacy) {
            const migrated = migrateSessionJsonl(readFileSync(path, "utf8"), loaded.header.sessionId);
            atomicWrite(
              path,
              serializeRecords([
                { type: "header", header: migrated.header },
                ...migrated.frames.map((frame) => ({ type: "frame" as const, frame })),
                ...snapshot.pending.map((intent) => ({ type: "pending" as const, id: intent.id, frame: intent.frame })),
                ...[...snapshot.acks].map((id) => ({ type: "ack" as const, id })),
                ...[...snapshot.cancelled].map((id) => ({ type: "cancel" as const, id })),
              ])
            );
          }
          refresh();
          return { state: loaded.state, committed, retryable, badLines: snapshot.badLines };
        } finally {
          releaseLease();
          refresh();
        }
      });
    },
    lease() {
      return currentLease;
    },
    pendingIntents() {
      refresh();
      return loaded.snapshot.pending
        .filter(
          (intent) => !loaded.snapshot.acks.has(intent.id) && !loaded.snapshot.cancelled.has(intent.id)
        )
        .map((intent) => ({ ...intent }));
    },
    migrate(): MigrationResult {
      const from = versionAtOpen;
      if (from > SESSION_STORE_VERSION) return { from, to: from, migrated: false };
      if (from === SESSION_STORE_VERSION && !loaded.snapshot.legacy) {
        return { from, to: from, migrated: false };
      }
      const header = writeMigrated(loaded.header.sessionId);
      loaded = classify(readSnapshot(), header);
      return { from, to: loaded.header.version, migrated: from < loaded.header.version };
    },
    close() {
      closed = true;
    },
  };

  return store;
}
