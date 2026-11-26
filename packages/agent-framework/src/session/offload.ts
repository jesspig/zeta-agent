import type { AgentListener } from "../runtime/agent";
import { classifyRecap, safeCutIndex } from "./recap";
import {
  createRecap,
  type CompactionLineage,
  type SemanticRecap,
  type SessionSurface,
  type SurfaceEntry,
} from "./surface";

export interface CompactionBudget {
  readonly totalContextLimit: number;
  readonly compactionThreshold: number;
  readonly peakLiveContextTokens?: number;
}

export type BudgetDecision = "ok" | "compact" | "exceeded";

/** EoCC=阈值触发（默认）；SAC=每动作一次，共享同一 recap schema。 */
export type CompactionMode = "EoCC" | "SAC";

export interface ResolveCompactionBudgetInput {
  readonly totalContextLimit: number;
  readonly compactionThreshold?: number;
  /** 外置块/工具输出字节上限；与阈值联动，保证 verbose 轨迹仍有工作空间。 */
  readonly maxOutputBytes?: number;
  readonly mode?: CompactionMode;
}

export interface BudgetTracker {
  observe(tokens: number): BudgetDecision;
  readonly peak: number;
  readonly decision: BudgetDecision;
}

export interface WorkspaceStore {
  put(uri: string, data: unknown): void | Promise<void>;
  get(uri: string): unknown | Promise<unknown>;
}

export interface OffloaderOptions {
  /** 外置块序列化后的输出字节上限；超限按完整条目裁剪。缺省不限制。 */
  readonly maxOutputBytes?: number;
}

export interface Offloader {
  offload(block: unknown, label?: string): Promise<string>;
  retrieve<T = unknown>(uri: string, maxOutputBytes?: number): Promise<T | undefined>;
}

export interface CompactionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly peakTokens: number;
  readonly compactionCount: number;
  readonly preTokenCount: number;
  readonly postTokenCount: number;
}

export type CompactionEvent =
  | { readonly type: "compaction_started"; readonly threshold: number; readonly preTokenCount: number }
  | {
      readonly type: "compaction_completed";
      readonly threshold: number;
      readonly preTokenCount: number;
      readonly postTokenCount: number;
      readonly uris: readonly string[];
      readonly usage: CompactionUsage;
    }
  | {
      readonly type: "compaction_failed";
      readonly threshold: number;
      readonly preTokenCount: number;
      readonly reason: string;
      readonly code: string;
    }
  | { readonly type: "compaction_interrupted"; readonly preTokenCount: number; readonly reason: string };

export interface CompactionListenerOptions {
  readonly budget: CompactionBudget;
  readonly surface: SessionSurface;
  readonly offloader: Offloader;
  readonly persist: (lineages: readonly CompactionLineage[]) => void | Promise<void>;
  readonly countTokens?: (entries: readonly SurfaceEntry[]) => number;
  readonly buildRecap?: (block: readonly SurfaceEntry[], uris: readonly string[]) => SemanticRecap;
  /** started/completed/failed/interrupted 事件；facade 可据此落审计。 */
  readonly emit?: (event: CompactionEvent) => void | Promise<void>;
  /** 中断信号：abort 时不改上下文并发 interrupted。 */
  readonly signal?: AbortSignal;
  /** 旁路 peak 指标观测点；与 budget 阈值独立。 */
  readonly budgetTracker?: BudgetTracker;
}

const WORKSPACE_PREFIX = "workspace:///";
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBudget(budget: CompactionBudget): void {
  if (!isRecord(budget)) throw new Error("budget: expected an object");
  const { totalContextLimit, compactionThreshold, peakLiveContextTokens } = budget;
  if (typeof totalContextLimit !== "number" || !Number.isFinite(totalContextLimit) || totalContextLimit <= 0) {
    throw new Error("budget: invalid totalContextLimit");
  }
  if (typeof compactionThreshold !== "number" || !Number.isFinite(compactionThreshold) || compactionThreshold <= 0) {
    throw new Error("budget: invalid compactionThreshold");
  }
  if (compactionThreshold >= totalContextLimit) {
    throw new Error("budget: compactionThreshold must be below totalContextLimit");
  }
  if (peakLiveContextTokens !== undefined && (typeof peakLiveContextTokens !== "number" || !Number.isFinite(peakLiveContextTokens) || peakLiveContextTokens <= 0)) {
    throw new Error("budget: invalid peakLiveContextTokens");
  }
}

/**
 * EoCC/SAC 与 maxOutputBytes 的唯一解析入口：
 * - EoCC 缺省阈值取上下文上限的 3/4；SAC 缺省为 1（每动作压缩）。
 * - 显式阈值与 maxOutputBytes 取更严格者：threshold <= totalContextLimit - maxOutputBytes，
 *   防止 verbose 轨迹在紧阈值下没有工作空间而崩塌。
 */
export function resolveCompactionBudget(input: ResolveCompactionBudgetInput): CompactionBudget {
  const { totalContextLimit, compactionThreshold, maxOutputBytes, mode = "EoCC" } = input;
  if (mode !== "EoCC" && mode !== "SAC") throw new Error("budget: invalid compaction mode");
  if (maxOutputBytes !== undefined && (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0)) {
    throw new Error("budget: invalid maxOutputBytes");
  }
  const requested = compactionThreshold ?? (mode === "SAC" ? 1 : Math.floor(totalContextLimit * 0.75));
  const workspaceFloor = maxOutputBytes === undefined
    ? requested
    : Math.min(requested, Math.max(1, Math.floor(totalContextLimit - maxOutputBytes)));
  const threshold = Math.max(1, Math.floor(workspaceFloor));
  const budget: CompactionBudget = { totalContextLimit, compactionThreshold: threshold };
  assertBudget(budget);
  return budget;
}

export function checkBudget(budget: CompactionBudget, liveTokens: number): BudgetDecision {
  assertBudget(budget);
  if (typeof liveTokens !== "number" || !Number.isFinite(liveTokens) || liveTokens < 0) {
    throw new Error("budget: invalid live token count");
  }
  if (liveTokens > budget.totalContextLimit) return "exceeded";
  if (liveTokens >= budget.compactionThreshold) return "compact";
  return "ok";
}

export function createBudgetTracker(budget: CompactionBudget): BudgetTracker {
  assertBudget(budget);
  let peak = 0;
  let decision: BudgetDecision = "ok";
  return {
    observe(tokens) {
      decision = checkBudget(budget, tokens);
      if (tokens > peak) peak = tokens;
      return decision;
    },
    get peak() {
      return peak;
    },
    get decision() {
      return decision;
    },
  };
}

export function createMemoryWorkspaceStore(): WorkspaceStore {
  const data = new Map<string, unknown>();
  return {
    put(uri, value) {
      if (typeof uri !== "string" || uri.length === 0) throw new Error("workspace store: invalid uri");
      data.set(uri, value);
    },
    get(uri) {
      if (typeof uri !== "string" || uri.length === 0) throw new Error("workspace store: invalid uri");
      return data.get(uri);
    },
  };
}

function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

/** 按完整条目裁剪序列化输出，避免把半条消息写进 workspace 或回显给调用方。 */
export function boundOutputBytes<T>(value: T, maxOutputBytes: number | undefined): T {
  if (maxOutputBytes === undefined || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) return value;
  if (serializedBytes(value) <= maxOutputBytes) return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const candidate = [...kept, item];
      if (serializedBytes(candidate) > maxOutputBytes) break;
      kept.push(item);
    }
    return kept as T;
  }
  return JSON.stringify(value).slice(0, maxOutputBytes) as T;
}

// 进程级唯一序列：跨实例（乃至跨重启后复用 store）都不复用同一 URI，
// 否则旧血缘会指向后来写入的区块。
let offloaderSequence = 0;
function nextOffloadId(): string {
  offloaderSequence += 1;
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${offloaderSequence.toString(36)}-${random}`;
}

export function createOffloader(store: WorkspaceStore, options: OffloaderOptions = {}): Offloader {
  return {
    async offload(block, label = "block") {
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_") || "block";
      const uri = `${WORKSPACE_PREFIX}${safeLabel}-${nextOffloadId()}`;
      await store.put(uri, boundOutputBytes(block, options.maxOutputBytes));
      return uri;
    },
    async retrieve<T>(uri: string, maxOutputBytes?: number) {
      if (typeof uri !== "string" || !uri.startsWith(WORKSPACE_PREFIX)) {
        throw new Error("offloader: expected a workspace uri");
      }
      const limit = maxOutputBytes ?? options.maxOutputBytes;
      return boundOutputBytes((await store.get(uri)) as T | undefined, limit);
    },
  };
}

function defaultCountTokens(entries: readonly SurfaceEntry[]): number {
  return entries.reduce((total, entry) => {
    const source = entry.kind === "message" ? entry.message : entry.uris;
    return total + Math.ceil(JSON.stringify(source).length / 4);
  }, 0);
}

export class CompactionInterruptedError extends Error {
  readonly code = "COMPACTION_INTERRUPTED";
  constructor() {
    super("compaction interrupted");
    this.name = "CompactionInterruptedError";
  }
}

export class CompactionOverflowError extends Error {
  readonly code = "OVERFLOW_UNRECOVERABLE";
  constructor(observed: number, limit: number) {
    super(`totalContextLimit exceeded after one recovery: ${observed} > ${limit}`);
    this.name = "CompactionOverflowError";
  }
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "COMPACTION_FAILED";
}

export { safeCutIndex };

export function createCompactionListener(options: CompactionListenerOptions): AgentListener {
  const { budget, surface, offloader, persist } = options;
  assertBudget(budget);
  const countTokens = options.countTokens ?? defaultCountTokens;
  const buildRecap = options.buildRecap ?? classifyRecap;
  const emit = options.emit ?? (() => {});
  const signal = options.signal;
  const tracker = options.budgetTracker;

  const fire = async (event: CompactionEvent): Promise<void> => {
    await emit(event);
  };

  /** 单次外置 + 原子替换；block/cut 在首个 await 之前捕获，避免错过并发变更窗口。 */
  async function compactOnce(
    block: readonly SurfaceEntry[],
    cut: number,
    preTokenCount: number
  ): Promise<readonly string[]> {
    if (cut <= 0) return [];
    const uri = await offloader.offload(block, "compaction");
    if (signal?.aborted === true) throw new CompactionInterruptedError();

    const current = surface.entries();
    const stillSame =
      current.length >= cut &&
      block.every((entry, index) => current[index] === entry);
    if (stillSame) {
      surface.replace({
        start: 0,
        end: cut,
        recap: createRecap(buildRecap(block, [uri])),
        uris: [uri],
        threshold: budget.compactionThreshold,
        preTokenCount,
      });
    }
    return [uri];
  }

  return async (event) => {
    if (event.type !== "agent_end") return;
    // 同步捕获计划：事件派发中的 await 之前完成，保证条件提交的身份比较仍基于原始条目。
    const snapshot = surface.snapshot();
    const preTokenCount = countTokens(snapshot.entries);
    const decision = checkBudget(budget, preTokenCount);
    const cut = safeCutIndex(snapshot.entries, Math.max(1, Math.ceil(snapshot.entries.length / 2)));
    const plannedBlock = snapshot.entries.slice(0, cut);
    const abortedAtStart = signal?.aborted === true;
    tracker?.observe(preTokenCount);
    await fire({ type: "compaction_started", threshold: budget.compactionThreshold, preTokenCount });

    if (abortedAtStart) {
      await fire({ type: "compaction_interrupted", preTokenCount, reason: "aborted" });
      return;
    }

    try {
      let uris: readonly string[] = [];
      if (decision !== "ok") {
        uris = await compactOnce(plannedBlock, cut, preTokenCount);
        if (decision === "exceeded") {
          // 硬超限只允许一次恢复；再检查仍超限即失败并回滚。
          const recovered = countTokens(surface.entries());
          tracker?.observe(recovered);
          if (checkBudget(budget, recovered) === "exceeded") {
            throw new CompactionOverflowError(recovered, budget.totalContextLimit);
          }
        }
      }

      const postTokenCount = countTokens(surface.entries());
      tracker?.observe(postTokenCount);
      const lineages = surface.lineage();
      await persist(lineages);
      const peakTokens = Math.max(tracker?.peak ?? 0, preTokenCount, postTokenCount);
      const usage: CompactionUsage = {
        inputTokens: preTokenCount,
        outputTokens: postTokenCount,
        totalTokens: preTokenCount + postTokenCount,
        peakTokens,
        compactionCount: lineages.length,
        preTokenCount,
        postTokenCount,
      };
      await fire({
        type: "compaction_completed",
        threshold: budget.compactionThreshold,
        preTokenCount,
        postTokenCount,
        uris,
        usage,
      });
    } catch (error) {
      surface.restore(snapshot);
      if (error instanceof CompactionInterruptedError) {
        await fire({ type: "compaction_interrupted", preTokenCount, reason: error.message });
      } else {
        await fire({
          type: "compaction_failed",
          threshold: budget.compactionThreshold,
          preTokenCount,
          reason: error instanceof Error ? error.message : String(error),
          code: errorCode(error),
        });
      }
      throw error;
    }
  };
}
