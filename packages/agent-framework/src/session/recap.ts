import type { AgentMessage } from "../runtime/agent";
import {
  createRecap,
  type AppliedChange,
  type EstablishedFact,
  type SemanticRecap,
  type SurfaceEntry,
  type Verification,
} from "./surface";

type MessageEntry = Extract<SurfaceEntry, { kind: "message" }>;

export interface EntryGroup {
  readonly start: number;
  readonly end: number;
  readonly entries: readonly SurfaceEntry[];
}

function isMessageEntry(entry: SurfaceEntry): entry is MessageEntry {
  return entry.kind === "message";
}

interface ToolCallLike {
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

function toolCallsOf(message: AgentMessage): readonly ToolCallLike[] {
  const calls = (message as { toolCalls?: readonly ToolCallLike[] }).toolCalls;
  return calls ?? [];
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 把 assistant 的工具调用与紧随其后、按 toolCallId 匹配的 toolResult 合成一组。 */
export function groupEntries(entries: readonly SurfaceEntry[]): readonly EntryGroup[] {
  const groups: EntryGroup[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (isMessageEntry(entry) && entry.message.role === "assistant") {
      const pending = new Set(
        toolCallsOf(entry.message).map((call) => call.id).filter((id): id is string => typeof id === "string")
      );
      const grouped: SurfaceEntry[] = [entry];
      let next = index + 1;
      while (next < entries.length && pending.size > 0) {
        const candidate = entries[next]!;
        if (
          isMessageEntry(candidate) &&
          candidate.message.role === "toolResult" &&
          candidate.message.toolCallId !== undefined &&
          pending.has(candidate.message.toolCallId)
        ) {
          grouped.push(candidate);
          pending.delete(candidate.message.toolCallId);
          next += 1;
        } else {
          break;
        }
      }
      groups.push({ start: index, end: next, entries: grouped });
      index = next;
      continue;
    }
    groups.push({ start: index, end: index + 1, entries: [entry] });
    index += 1;
  }
  return groups;
}

/** 切割点永远落在完整组边界上，不会把工具调用与结果拆到两侧。 */
export function safeCutIndex(entries: readonly SurfaceEntry[], preferred: number): number {
  if (entries.length === 0) return 0;
  const target = Math.max(1, Math.min(Math.trunc(preferred), entries.length));
  const groups = groupEntries(entries);
  return (groups.find((group) => group.end >= target) ?? groups[groups.length - 1]!).end;
}

/** 取不超过 maxEntries 条、且左右边界都落在完整组上的尾部。 */
export function messageBoundaryTail(entries: readonly SurfaceEntry[], maxEntries: number): readonly SurfaceEntry[] {
  if (maxEntries <= 0 || entries.length === 0) return [];
  const groups = groupEntries(entries);
  const chosen: EntryGroup[] = [];
  let count = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const size = group.end - group.start;
    if (count + size > maxEntries) break;
    chosen.unshift(group);
    count += size;
  }
  return chosen.flatMap((group) => [...group.entries]);
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isErrorOf(message: AgentMessage): boolean {
  return (message as { isError?: unknown }).isError === true;
}

function fieldOf(args: Record<string, unknown>, ...names: readonly string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

const EDIT_TOOLS = /^(write|edit|create|apply_patch)$/i;
const CHECK_TOOLS = /test|check|verif|lint|bun|npm|pnpm|grep|bash|shell/i;

/**
 * 从待压缩块构造 typed recap：system 逐字进 objective，工具成功输出是 observation，
 * 用户/助手正文只作 unverified，失败工具进 deadEnds，编辑/check 工具分别进
 * appliedChanges / verification。分类刻意保守，不把未验证声称提升为事实。
 */
export function classifyRecap(block: readonly SurfaceEntry[], uris: readonly string[]): SemanticRecap {
  const messages = block.filter(isMessageEntry).map((entry) => entry.message);
  const objective = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");
  const establishedFacts: EstablishedFact[] = [];
  const appliedChanges: AppliedChange[] = [];
  const verification: Verification[] = [];
  const deadEnds: string[] = [];

  for (const group of groupEntries(block)) {
    const assistants = group.entries
      .filter(isMessageEntry)
      .filter((entry) => entry.message.role === "assistant")
      .map((entry) => entry.message);
    const results = group.entries
      .filter(isMessageEntry)
      .filter((entry) => entry.message.role === "toolResult")
      .map((entry) => entry.message);
    const resultsById = new Map(results.map((result) => [result.toolCallId ?? "", result]));

    for (const assistant of assistants) {
      for (const call of toolCallsOf(assistant)) {
        if (!EDIT_TOOLS.test(call.name ?? "")) continue;
        const args = parseArgs(call.arguments);
        const result = call.id === undefined ? undefined : resultsById.get(call.id);
        const failed = result !== undefined && isErrorOf(result);
        appliedChanges.push({
          file: fieldOf(args, "path", "file", "target") || (call.name ?? "unknown"),
          what: result === undefined ? textOf(assistant.content) : textOf(result.content),
          verified: result !== undefined && !failed,
        });
      }
      const claim = textOf(assistant.content);
      if (claim.length > 0) establishedFacts.push({ text: claim, kind: "unverified" });
    }

    for (const result of results) {
      const text = textOf(result.content);
      if (isErrorOf(result)) {
        if (text.length > 0) deadEnds.push(text);
        continue;
      }
      if (text.length > 0) establishedFacts.push({ text, kind: "observation" });
      const name = result.toolName ?? "";
      if (CHECK_TOOLS.test(name)) verification.push({ check: name, result: text });
    }

    for (const entry of group.entries) {
      if (!isMessageEntry(entry) || entry.message.role !== "user") continue;
      const text = textOf(entry.message.content);
      if (text.length > 0) establishedFacts.push({ text, kind: "unverified" });
    }
  }

  return createRecap({
    objective,
    establishedFacts,
    appliedChanges,
    verification,
    deadEnds,
    remainingPlan: uris.map((uri) => `retrieve ${uri} when needed`),
  });
}
