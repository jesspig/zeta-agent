import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentMessage, CompactionLineage, SemanticRecap } from "@zeta-agent/agent-framework";

/** 单条 JSONL 记录：id / parentId 构成会话树，payload 承载消息或 recap。 */
export type JsonlEntry =
  | {
      readonly id: string;
      readonly parentId: string | null;
      readonly kind: "message";
      readonly message: AgentMessage;
    }
  | {
      readonly id: string;
      readonly parentId: string | null;
      readonly kind: "recap";
      readonly recap: SemanticRecap;
      readonly uris: readonly string[];
      /** 血缘元数据，复用 agent-framework 的 CompactionLineage 形状。 */
      readonly lineage: CompactionLineage;
    };

export function serializeJsonl(entries: readonly JsonlEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
}

export function parseJsonl(text: string): JsonlEntry[] {
  const out: JsonlEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    out.push(JSON.parse(line) as JsonlEntry);
  }
  return out;
}

export interface SessionTree {
  /** 追加一条消息到当前 leaf 之后。 */
  append(message: AgentMessage): JsonlEntry;
  /** 从指定条目分叉出新分支，返回新分支首条（空 kind 标记）条目 id。 */
  fork(fromId: string): string;
  /** 把给定条目复制到本树，作为独立会话的新历史（不改源条目）。 */
  clone(entries: readonly JsonlEntry[]): SessionTree;
  /** 压缩：写入 recap 血缘节点（保留父子链），复用 SemanticRecap。 */
  compact(recap: SemanticRecap, uris: readonly string[]): JsonlEntry;
  /** 分支摘要：与 compact 同构的血缘节点，用于分支合并/标记。 */
  summarizeBranch(recap: SemanticRecap): JsonlEntry;
  /** 当前全部条目（按写入顺序）。 */
  entries(): readonly JsonlEntry[];
  /** 当前 leaf id。 */
  leaf(): string | undefined;
  /** 从 leaf 沿 parentId 回溯的活跃分支。 */
  activeBranch(): readonly JsonlEntry[];
  /** 血缘记录列表。 */
  lineage(): readonly CompactionLineage[];
}

export interface SessionTreeOptions {
  readonly path: string;
  /** 血缘阈值（compact 使用）。 */
  readonly threshold?: number;
  /** 压缩前 token 计数（compact 使用）。 */
  readonly preTokenCount?: number;
}

function makeId(): string {
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * JSONL 会话树：每条记录带 id/parentId，leaf 决定活跃分支；
 * fork/clone 只追加新条目不改历史；compact/分支摘要复用 agent-framework 的
 * SemanticRecap / CompactionLineage，血缘可审计。
 */
export function createSessionTree(options: SessionTreeOptions): SessionTree {
  let entries: JsonlEntry[] = existsSync(options.path)
    ? parseJsonl(readFileSync(options.path, "utf8"))
    : [];
  let leafId: string | undefined = entries.at(-1)?.id;
  const lineages: CompactionLineage[] = entries
    .filter((entry): entry is Extract<JsonlEntry, { kind: "recap" }> => entry.kind === "recap")
    .map((entry) => entry.lineage);

  function persist(entry: JsonlEntry): void {
    if (!existsSync(options.path)) writeFileSync(options.path, "");
    appendFileSync(options.path, serializeJsonl([entry]));
  }

  function appendEntry(entry: JsonlEntry): JsonlEntry {
    // 先持久化再发布内存状态：写盘失败时 leaf/entries/血缘都不推进。
    persist(entry);
    entries = [...entries, entry];
    leafId = entry.id;
    return entry;
  }

  function makeLineage(recap: SemanticRecap, uris: readonly string[]): CompactionLineage {
    return {
      threshold: options.threshold ?? 0,
      recap,
      uris: [...uris],
      preTokenCount: options.preTokenCount ?? 0,
    };
  }

  const tree: SessionTree = {
    append(message) {
      return appendEntry({
        id: makeId(),
        parentId: leafId ?? null,
        kind: "message",
        message,
      });
    },
    fork(fromId) {
      const branchMarker = appendEntry({
        id: makeId(),
        parentId: fromId,
        kind: "recap",
        recap: createEmptyRecap(),
        uris: [],
        lineage: makeLineage(createEmptyRecap(), []),
      });
      // 分支标记不写入血缘（它不是压缩事件），从血缘数组移除其贡献。
      return branchMarker.id;
    },
    clone(sourceEntries) {
      // 构造全新的 id 序列并重新映射 parentId，保持拓扑但不改源条目。
      const idMap = new Map<string, string>();
      for (const entry of sourceEntries) idMap.set(entry.id, makeId());
      const clonedEntries: JsonlEntry[] = sourceEntries.map((entry) => {
        const parentId = entry.parentId === null ? null : idMap.get(entry.parentId) ?? null;
        const base = { id: idMap.get(entry.id) ?? makeId(), parentId } as Record<string, unknown>;
        if (entry.kind === "message") {
          return { ...base, kind: "message", message: entry.message } as unknown as JsonlEntry;
        }
        return {
          ...base,
          kind: "recap",
          recap: entry.recap,
          uris: entry.uris,
          lineage: entry.lineage,
        } as unknown as JsonlEntry;
      });
      const clonePath = `${options.path}.clone`;
      writeFileSync(clonePath, serializeJsonl(clonedEntries));
      return createSessionTree({ ...options, path: clonePath });
    },
    compact(recap, uris) {
      const lineage = makeLineage(recap, uris);
      // appendEntry 先持久化；血缘只在写盘成功后发布。
      const entry = appendEntry({
        id: makeId(),
        parentId: leafId ?? null,
        kind: "recap",
        recap,
        uris: [...uris],
        lineage,
      });
      lineages.push(lineage);
      return entry;
    },
    summarizeBranch(recap) {
      return tree.compact(recap, []);
    },
    entries() {
      return [...entries];
    },
    leaf() {
      return leafId;
    },
    activeBranch() {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const branch: JsonlEntry[] = [];
      let cursor = leafId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = byId.get(cursor);
        if (entry === undefined) break;
        branch.push(entry);
        cursor = entry.parentId ?? undefined;
      }
      return branch.reverse();
    },
    lineage() {
      return [...lineages];
    },
  };
  return tree;
}

function createEmptyRecap(): SemanticRecap {
  return {
    objective: "",
    establishedFacts: [],
    appliedChanges: [],
    verification: [],
    deadEnds: [],
    remainingPlan: [],
  };
}
