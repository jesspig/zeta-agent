import type { AgentListener } from "../runtime/agent";
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

export interface BudgetTracker {
  observe(tokens: number): BudgetDecision;
  readonly peak: number;
  readonly decision: BudgetDecision;
}

export interface WorkspaceStore {
  put(uri: string, data: unknown): void | Promise<void>;
  get(uri: string): unknown | Promise<unknown>;
}

export interface Offloader {
  offload(block: unknown, label?: string): Promise<string>;
  retrieve<T = unknown>(uri: string): Promise<T | undefined>;
}

export interface CompactionListenerOptions {
  readonly budget: CompactionBudget;
  readonly surface: SessionSurface;
  readonly offloader: Offloader;
  readonly persist: (lineages: readonly CompactionLineage[]) => void | Promise<void>;
  readonly countTokens?: (entries: readonly SurfaceEntry[]) => number;
  readonly buildRecap?: (block: readonly SurfaceEntry[], uris: readonly string[]) => SemanticRecap;
}

const WORKSPACE_PREFIX = "workspace:///";

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

export function createOffloader(store: WorkspaceStore): Offloader {
  let counter = 0;
  return {
    async offload(block, label = "block") {
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_") || "block";
      counter += 1;
      const uri = `${WORKSPACE_PREFIX}${safeLabel}-${counter}`;
      await store.put(uri, block);
      return uri;
    },
    async retrieve<T>(uri: string) {
      if (typeof uri !== "string" || !uri.startsWith(WORKSPACE_PREFIX)) {
        throw new Error("offloader: expected a workspace uri");
      }
      return (await store.get(uri)) as T | undefined;
    },
  };
}

function defaultCountTokens(entries: readonly SurfaceEntry[]): number {
  return entries.reduce((total, entry) => {
    const source = entry.kind === "message" ? entry.message : entry.uris;
    return total + Math.ceil(JSON.stringify(source).length / 4);
  }, 0);
}

function defaultBuildRecap(block: readonly SurfaceEntry[], uris: readonly string[]): SemanticRecap {
  const messages = block
    .filter((entry): entry is Extract<SurfaceEntry, { kind: "message" }> => entry.kind === "message")
    .map((entry) => entry.message);
  const system = messages.find((message) => message.role === "system");
  const objective = typeof system?.content === "string" ? system.content : "";
  return createRecap({
    objective,
    establishedFacts: messages.map((message) => ({
      text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      kind: "observation",
    })),
    appliedChanges: [],
    verification: [],
    deadEnds: [],
    remainingPlan: uris.length > 0 ? ["retrieve offloaded context when needed"] : [],
  });
}

export function createCompactionListener(options: CompactionListenerOptions): AgentListener {
  const { budget, surface, offloader, persist } = options;
  assertBudget(budget);
  const countTokens = options.countTokens ?? defaultCountTokens;
  const buildRecap = options.buildRecap ?? defaultBuildRecap;

  return async (event) => {
    if (event.type !== "agent_end") return;

    const entries = surface.entries();
    const preTokenCount = countTokens(entries);
    const decision = checkBudget(budget, preTokenCount);
    if (decision === "exceeded") {
      throw new Error(`totalContextLimit exceeded: ${preTokenCount} > ${budget.totalContextLimit}`);
    }

    if (decision === "compact" && entries.length > 0) {
      const cut = Math.max(1, Math.ceil(entries.length / 2));
      const block = entries.slice(0, cut);
      const uri = await offloader.offload(block, "compaction");
      surface.replace({
        start: 0,
        end: cut,
        recap: createRecap(buildRecap(block, [uri])),
        uris: [uri],
        threshold: budget.compactionThreshold,
        preTokenCount,
      });
    }

    await persist(surface.lineage());
  };
}
