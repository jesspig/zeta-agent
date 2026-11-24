import { createHash } from "node:crypto";

export type PromotionArtifact = string | Uint8Array;

export interface Candidate {
  readonly id: string;
  readonly fitness: number;
  readonly qualified: boolean;
  /** 可选观察等价指纹；未注入时默认晋升路径保持原状。 */
  readonly fingerprint?: string;
}

export type PromotionRejectionReason = "digest-mismatch";

export interface PromotionDecision {
  readonly candidate: Candidate;
  readonly promoted: boolean;
  readonly fitness: number;
  readonly reason?: PromotionRejectionReason;
  readonly digest?: string;
}

export interface PromotionState {
  readonly incumbent: Candidate | undefined;
  readonly history: readonly PromotionDecision[];
}

function assertCandidate(candidate: Candidate): void {
  if (candidate === null || typeof candidate !== "object") throw new Error("INVALID_CANDIDATE");
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("INVALID_CANDIDATE: id required");
  }
  if (!Number.isFinite(candidate.fitness)) throw new Error(`INVALID_FITNESS: ${candidate.id}`);
  if (typeof candidate.qualified !== "boolean") {
    throw new Error(`INVALID_QUALIFIED: ${candidate.id}`);
  }
  if (
    candidate.fingerprint !== undefined &&
    (typeof candidate.fingerprint !== "string" || candidate.fingerprint.length === 0)
  ) {
    throw new Error(`INVALID_FINGERPRINT: ${candidate.id}`);
  }
}

interface PromotionCheck {
  readonly allow: boolean;
  readonly digest?: string;
  readonly reason?: PromotionRejectionReason;
}

function applyPromotion(
  state: PromotionState,
  candidate: Candidate,
  check?: PromotionCheck
): PromotionState {
  assertCandidate(candidate);
  const incumbent = state.incumbent;
  const promoted =
    (check === undefined || check.allow) &&
    candidate.qualified &&
    (incumbent === undefined || candidate.fitness > incumbent.fitness);
  const nextIncumbent = promoted ? candidate : incumbent;
  const decision: PromotionDecision = Object.freeze({
    candidate,
    promoted,
    fitness: nextIncumbent?.fitness ?? 0,
    ...(check?.digest !== undefined ? { digest: check.digest } : {}),
    ...(check?.reason !== undefined ? { reason: check.reason } : {}),
  });
  return Object.freeze({
    incumbent: nextIncumbent,
    history: Object.freeze([...state.history, decision]),
  });
}

export function createPromotionState(initial?: Candidate): PromotionState {
  if (initial !== undefined) assertCandidate(initial);
  return Object.freeze({ incumbent: initial, history: Object.freeze([]) });
}

/** 默认晋升路径：资格 + incumbent 参赛 + 严格更优，不附加任何可选护栏。 */
export function promote(state: PromotionState, candidate: Candidate): PromotionState {
  return applyPromotion(state, candidate);
}

const HEX_DIGEST = /^[0-9a-f]{64}$/i;

function assertExpectedDigest(value: unknown): string {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) throw new Error("INVALID_DIGEST");
  return value.toLowerCase();
}

/** 产物摘要；字符串按 UTF-8 字节流计算，二进制按原字节计算。 */
export function sha256Hex(value: PromotionArtifact): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("INVALID_ARTIFACT");
  return createHash("sha256").update(value).digest("hex");
}

export function matchesArtifactDigest(artifact: PromotionArtifact, expectedDigest: string): boolean {
  return sha256Hex(artifact) === assertExpectedDigest(expectedDigest);
}

export interface DigestPromotionOptions {
  readonly artifact: PromotionArtifact;
  readonly expectedDigest: string;
}

/**
 * SE-D7 可选护栏：晋升前做 copy → sha256 比对，摘要不符则保留 incumbent。
 * 拒绝仍记入 history，保持预算恒等式可核验。
 */
export function promoteWithDigest(
  state: PromotionState,
  candidate: Candidate,
  options: DigestPromotionOptions
): PromotionState {
  assertCandidate(candidate);
  const expected = assertExpectedDigest(options.expectedDigest);
  const digest = sha256Hex(options.artifact);
  return digest === expected
    ? applyPromotion(state, candidate, { allow: true, digest })
    : applyPromotion(state, candidate, { allow: false, digest, reason: "digest-mismatch" });
}

export type ObservationContext = Readonly<Record<string, unknown>>;

function observationKeys(context: ObservationContext, keys?: readonly string[]): readonly string[] {
  if (keys === undefined) return Object.keys(context).sort();
  if (!Array.isArray(keys)) throw new Error("INVALID_OBSERVATION_KEYS");
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("INVALID_OBSERVATION_KEYS");
  }
  return [...new Set(keys)].sort();
}

function assertObservationContext(context: ObservationContext): void {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("INVALID_OBSERVATION_CONTEXT");
  }
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) return JSON.stringify(`bytes:${value.length}`);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** 对指定 ctx 键的投影取稳定摘要，作为 harness 指纹的可插入替身。 */
export function contextFingerprint(context: ObservationContext, keys?: readonly string[]): string {
  assertObservationContext(context);
  const selected = observationKeys(context, keys);
  const projection: Record<string, unknown> = {};
  for (const key of selected) projection[key] = context[key];
  return sha256Hex(stableStringify(projection));
}

/** 公开操作集合：键存在性、取值、属性描述符，均按同一组键逐项比较。 */
export const CONTEXT_KEY_OPERATIONS: readonly ("has" | "get" | "descriptor")[] = Object.freeze([
  "has",
  "get",
  "descriptor",
]);

/** SE-H3/A18 可选断言：晋升前后 ctx 在指定键上的公开操作必须一致。 */
export function assertObservationEquivalence(
  before: ObservationContext,
  after: ObservationContext,
  keys?: readonly string[]
): true {
  assertObservationContext(before);
  assertObservationContext(after);
  const selected =
    keys === undefined
      ? [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      : observationKeys(before, keys);
  for (const key of selected) {
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hasBefore !== hasAfter) throw new Error(`OBSERVATION_EQUIVALENCE_MISMATCH: has(${key})`);
    if (!hasBefore) continue;
    if (stableStringify(before[key]) !== stableStringify(after[key])) {
      throw new Error(`OBSERVATION_EQUIVALENCE_MISMATCH: get(${key})`);
    }
    const left = Object.getOwnPropertyDescriptor(before, key);
    const right = Object.getOwnPropertyDescriptor(after, key);
    for (const flag of ["enumerable", "writable", "configurable"] as const) {
      if (left?.[flag] !== right?.[flag]) {
        throw new Error(`OBSERVATION_EQUIVALENCE_MISMATCH: descriptor(${key}).${flag}`);
      }
    }
  }
  return true;
}

export interface ObservationPromotionOptions {
  readonly before: ObservationContext;
  readonly after: ObservationContext;
  readonly keys?: readonly string[];
  readonly expectedFingerprint?: string;
}

/** 先复核指纹与观察等价，再走默认晋升路径；断言失败即抛出，绝不发生替换。 */
export function promoteWithObservationEquivalence(
  state: PromotionState,
  candidate: Candidate,
  options: ObservationPromotionOptions
): PromotionState {
  assertCandidate(candidate);
  const fingerprint = contextFingerprint(options.after, options.keys);
  if (candidate.fingerprint !== undefined && candidate.fingerprint !== fingerprint) {
    throw new Error(`FINGERPRINT_MISMATCH: ${candidate.id}`);
  }
  if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== fingerprint) {
    throw new Error(`FINGERPRINT_MISMATCH: ${candidate.id}`);
  }
  assertObservationEquivalence(options.before, options.after, options.keys);
  return promote(state, candidate);
}

export function replayPromotion(candidates: readonly Candidate[], initial?: Candidate): PromotionState {
  return candidates.reduce(promote, createPromotionState(initial));
}

export function assertPromotionInvariants(
  state: PromotionState,
  considered: readonly Candidate[]
): boolean {
  if (state.history.length !== considered.length) throw new Error("PROMOTION_BUDGET_MISMATCH");
  if (new Set(state.history.map((item) => item.candidate.id)).size !== considered.length) {
    throw new Error("PROMOTION_DUPLICATE_CANDIDATE");
  }

  let lastFitness = Number.NEGATIVE_INFINITY;
  for (const decision of state.history) {
    if (decision.fitness < lastFitness) throw new Error("PROMOTION_NON_MONOTONIC");
    lastFitness = decision.fitness;
  }

  if (state.incumbent !== undefined) {
    for (const decision of state.history) {
      if (decision.fitness > state.incumbent.fitness) throw new Error("PROMOTION_RUNBEST_VIOLATION");
    }
  }
  return true;
}
