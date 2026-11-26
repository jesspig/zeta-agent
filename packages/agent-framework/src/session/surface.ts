import type { AgentMessage } from "../runtime/agent";

export interface EstablishedFact {
  readonly text: string;
  readonly kind: "observation" | "unverified";
}

export interface AppliedChange {
  readonly file: string;
  readonly what: string;
  readonly verified: boolean;
}

export interface Verification {
  readonly check: string;
  readonly result: string;
}

export interface SemanticRecap {
  readonly objective: string;
  readonly establishedFacts: readonly EstablishedFact[];
  readonly appliedChanges: readonly AppliedChange[];
  readonly verification: readonly Verification[];
  readonly deadEnds: readonly string[];
  readonly remainingPlan: readonly string[];
}

export const RECAP_SEGMENTS = [
  "objective",
  "establishedFacts",
  "appliedChanges",
  "verification",
  "deadEnds",
  "remainingPlan",
] as const satisfies readonly (keyof SemanticRecap)[];

export type SurfaceEntry =
  | { readonly kind: "message"; readonly message: AgentMessage }
  | { readonly kind: "recap"; readonly recap: SemanticRecap; readonly uris: readonly string[] };

export interface CompactionLineage {
  readonly threshold: number;
  readonly recap: SemanticRecap;
  readonly uris: readonly string[];
  readonly preTokenCount: number;
}

export interface ReplaceOperation {
  readonly start: number;
  readonly end: number;
  readonly recap: SemanticRecap;
  readonly uris: readonly string[];
  readonly threshold: number;
  readonly preTokenCount: number;
}

export interface SessionSnapshot {
  readonly entries: readonly SurfaceEntry[];
  readonly lineage: readonly CompactionLineage[];
}

export interface SessionSurface {
  append(message: AgentMessage): void;
  replace(op: ReplaceOperation): void;
  entries(): readonly SurfaceEntry[];
  lineage(): readonly CompactionLineage[];
  /** 压缩事务开始前取快照，失败时原子回滚。 */
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFact(value: unknown): value is EstablishedFact {
  return isRecord(value) && typeof value.text === "string" && (value.kind === "observation" || value.kind === "unverified");
}

function isChange(value: unknown): value is AppliedChange {
  return isRecord(value) && typeof value.file === "string" && typeof value.what === "string" && typeof value.verified === "boolean";
}

function isVerification(value: unknown): value is Verification {
  return isRecord(value) && typeof value.check === "string" && typeof value.result === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    isRecord(value) &&
    (value.role === "system" || value.role === "user" || value.role === "assistant" || value.role === "toolResult") &&
    "content" in value
  );
}

export function assertRecap(value: unknown): asserts value is SemanticRecap {
  if (!isRecord(value)) throw new Error("recap: expected an object");
  const keys = Object.keys(value).sort();
  const expected = [...RECAP_SEGMENTS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("recap: must contain exactly six segments");
  }
  if (typeof value.objective !== "string") throw new Error("recap: invalid objective");
  if (!Array.isArray(value.establishedFacts) || !value.establishedFacts.every(isFact)) {
    throw new Error("recap: invalid establishedFacts");
  }
  if (!Array.isArray(value.appliedChanges) || !value.appliedChanges.every(isChange)) {
    throw new Error("recap: invalid appliedChanges");
  }
  if (!Array.isArray(value.verification) || !value.verification.every(isVerification)) {
    throw new Error("recap: invalid verification");
  }
  if (!isStringArray(value.deadEnds)) throw new Error("recap: invalid deadEnds");
  if (!isStringArray(value.remainingPlan)) throw new Error("recap: invalid remainingPlan");
}

export function createRecap(input: SemanticRecap): SemanticRecap {
  assertRecap(input);
  return {
    objective: input.objective,
    establishedFacts: input.establishedFacts.map((fact) => ({ text: fact.text, kind: fact.kind })),
    appliedChanges: input.appliedChanges.map((change) => ({
      file: change.file,
      what: change.what,
      verified: change.verified,
    })),
    verification: input.verification.map((item) => ({ check: item.check, result: item.result })),
    deadEnds: [...input.deadEnds],
    remainingPlan: [...input.remainingPlan],
  };
}

const projectionEncoder = new TextEncoder();

function projectionBytes(value: string): number {
  return projectionEncoder.encode(value).length;
}

/** 按完整数组条目裁剪投影段；对象退化成有界字符串，绝不截断半个 JSON 数组条目。 */
function boundedSegment(value: unknown, budget: number): string {
  const raw = JSON.stringify(value) ?? "null";
  if (budget <= 0) return Array.isArray(value) ? "[]" : "{}";
  if (projectionBytes(raw) <= budget) return raw;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const candidate = [...kept, item];
      if (projectionBytes(JSON.stringify(candidate)) > budget) break;
      kept.push(item);
    }
    return JSON.stringify(kept);
  }
  return raw.slice(0, budget);
}

/**
 * 把 typed recap 投影成下一轮 provider 请求真实携带的 system 消息：
 * 六段齐全、objective 逐字保真、workspace URI 可见。
 *
 * 关键：被替换的原块只能以 workspace URI 指针出现，不能把 verbose 正文重新塞回请求——
 * 否则峰值不降反升，RED-06 的“旧块消失”也无法成立。详情由 offloader.retrieve 窄取回。
 */
export function projectRecapToMessage(
  recap: SemanticRecap,
  uris: readonly string[],
  maxOutputBytes?: number
): AgentMessage {
  const header = "Compacted conversation recap (six segments; objective verbatim):";
  const pointer = uris.length > 0 ? ` [details: ${uris.join(" ")}]` : "";
  const count = (key: string, items: readonly unknown[]): string => `${key}: ${items.length} item(s)${pointer}`;
  const planBudget = maxOutputBytes === undefined
    ? undefined
    : Math.max(0, maxOutputBytes - projectionBytes(header + "\n" + recap.objective + "\n" + uris.join(" ") + "\n"));
  const lines = [
    header,
    `objective: ${recap.objective}`,
    count("establishedFacts", recap.establishedFacts),
    count("appliedChanges", recap.appliedChanges),
    count("verification", recap.verification),
    count("deadEnds", recap.deadEnds),
    `remainingPlan: ${boundedSegment(recap.remainingPlan, planBudget ?? Number.POSITIVE_INFINITY)}`,
    `workspace: ${uris.join(" ")}`,
  ];
  return { role: "system", content: lines.join("\n") };
}

/** surface 是投影后的会话视图：recap 节点投影成 system 消息，message 节点原样透传。 */
export function projectSurfaceEntries(
  entries: readonly SurfaceEntry[],
  maxOutputBytes?: number
): readonly AgentMessage[] {
  return entries.map((entry) =>
    entry.kind === "message"
      ? entry.message
      : projectRecapToMessage(entry.recap, entry.uris, maxOutputBytes));
}

export function createSessionSurface(): SessionSurface {
  let entries: SurfaceEntry[] = [];
  let lineage: CompactionLineage[] = [];

  return {
    append(message) {
      if (!isAgentMessage(message)) throw new Error("surface.append: invalid message");
      entries = [...entries, { kind: "message", message }];
    },
    replace(op) {
      if (!isRecord(op)) throw new Error("surface.replace: invalid operation");
      const { start, end, recap, uris, threshold, preTokenCount } = op;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        (start as number) < 0 ||
        (start as number) >= (end as number) ||
        (end as number) > entries.length
      ) {
        throw new Error("surface.replace: invalid range");
      }
      assertRecap(recap);
      if (!isStringArray(uris) || uris.some((uri) => uri.length === 0)) {
        throw new Error("surface.replace: invalid uris");
      }
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
        throw new Error("surface.replace: invalid threshold");
      }
      if (typeof preTokenCount !== "number" || !Number.isFinite(preTokenCount) || preTokenCount < 0) {
        throw new Error("surface.replace: invalid preTokenCount");
      }

      const nextRecap = createRecap(recap);
      const nextUris = [...uris];
      const next: SurfaceEntry[] = [
        ...entries.slice(0, start as number),
        { kind: "recap", recap: nextRecap, uris: nextUris },
        ...entries.slice(end as number),
      ];
      entries = next;
      lineage = [...lineage, { threshold, recap: nextRecap, uris: nextUris, preTokenCount }];
    },
    entries: () => [...entries],
    lineage: () => [...lineage],
    snapshot() {
      return { entries: [...entries], lineage: [...lineage] };
    },
    restore(snapshot) {
      if (!isRecord(snapshot) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.lineage)) {
        throw new Error("surface.restore: invalid snapshot");
      }
      entries = [...snapshot.entries];
      lineage = [...snapshot.lineage];
    },
  };
}
