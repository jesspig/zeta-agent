/**
 * 模块内未公开的不可伪造令牌。晋升与评估的权威入口持有签发权；
 * 包出口不暴露签发函数，因此外部无法绕过 pipeline 直接调用底层原语。
 */
const PROMOTION_SEALS = new WeakSet<object>();
const PROMOTION_SEAL_BODIES = new WeakMap<object, string>();
const EVALUATOR_SEALS = new WeakSet<object>();

function sealStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(sealStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${sealStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export interface PromotionSeal {
  readonly kind: "promotion";
  readonly candidateId: string;
  readonly identityDigest: string;
}

export interface EvaluatorSeal {
  readonly kind: "evaluator";
  readonly candidateId: string;
  readonly identityDigest: string;
}

interface SealInput {
  readonly candidateId: string;
  readonly identityDigest: string;
  /** seal 绑定候选正文，复制 seal 篡改 fitness/qualified 会失效。 */
  readonly body?: unknown;
}

function assertSealInput(value: unknown): asserts value is SealInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_SEAL_INPUT");
  }
  const input = value as SealInput;
  if (
    typeof input.candidateId !== "string" ||
    input.candidateId.length === 0 ||
    typeof input.identityDigest !== "string" ||
    input.identityDigest.length === 0
  ) {
    throw new Error("INVALID_SEAL_INPUT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function issuePromotionSeal(input: SealInput): PromotionSeal {
  assertSealInput(input);
  const seal: PromotionSeal = Object.freeze({
    kind: "promotion",
    candidateId: input.candidateId,
    identityDigest: input.identityDigest,
  });
  PROMOTION_SEALS.add(seal);
  PROMOTION_SEAL_BODIES.set(
    seal,
    sealStringify(input.body ?? { candidateId: input.candidateId, identityDigest: input.identityDigest })
  );
  return seal;
}

export function issueEvaluatorSeal(input: SealInput): EvaluatorSeal {
  assertSealInput(input);
  const seal: EvaluatorSeal = Object.freeze({
    kind: "evaluator",
    candidateId: input.candidateId,
    identityDigest: input.identityDigest,
  });
  EVALUATOR_SEALS.add(seal);
  return seal;
}

export function isSealedPromotion(value: unknown): value is PromotionSeal {
  return isRecord(value) && value.kind === "promotion" && PROMOTION_SEALS.has(value);
}

export function isSealedEvaluator(value: unknown): value is EvaluatorSeal {
  return isRecord(value) && value.kind === "evaluator" && EVALUATOR_SEALS.has(value);
}

export function assertPromotionSeal(value: unknown): asserts value is PromotionSeal {
  if (!isSealedPromotion(value)) throw new Error("PROMOTION_SEAL_REQUIRED");
}

export function assertEvaluatorSeal(value: unknown): asserts value is EvaluatorSeal {
  if (!isSealedEvaluator(value)) throw new Error("EVALUATOR_SEAL_REQUIRED");
}

export function assertPromotionBody(value: unknown, body: unknown): true {
  if (
    !isRecord(value) ||
    PROMOTION_SEAL_BODIES.get(value) !== sealStringify(body)
  ) {
    throw new Error("PROMOTION_SEAL_BODY_MISMATCH");
  }
  return true;
}

/**
 * 一次性晋升授权。seal 只证明来源合法，授权进一步绑定 candidate/artifact/
 * snapshot/identity/nonce，且只能在唯一一次 commit 中消费；消费后 seal 不可
 * 被低阶 promote 系列再次使用。
 */
export interface PromotionAuthorizationBinding {
  readonly candidateId: string;
  readonly artifactDigest: string;
  readonly snapshotDigest: string;
  readonly identityDigest: string;
  readonly nonce: string;
}

const PROMOTION_AUTHORIZATION_BINDINGS = new WeakMap<object, PromotionAuthorizationBinding>();
const CONSUMED_PROMOTION_AUTHORIZATIONS = new WeakSet<object>();

function assertBinding(value: unknown): asserts value is PromotionAuthorizationBinding {
  if (!isRecord(value)) throw new Error("INVALID_PROMOTION_AUTHORIZATION");
  for (const field of [
    "candidateId",
    "artifactDigest",
    "snapshotDigest",
    "identityDigest",
    "nonce",
  ] as const) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
      throw new Error(`INVALID_PROMOTION_AUTHORIZATION: ${field}`);
    }
  }
}

function sameBinding(
  left: PromotionAuthorizationBinding,
  right: PromotionAuthorizationBinding
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.artifactDigest === right.artifactDigest &&
    left.snapshotDigest === right.snapshotDigest &&
    left.identityDigest === right.identityDigest &&
    left.nonce === right.nonce
  );
}

/** 由唯一权威入口（pipeline）把授权绑定到本次 run 的全部上下文。 */
export function bindPromotionAuthorization(
  seal: PromotionSeal,
  binding: PromotionAuthorizationBinding
): true {
  assertPromotionSeal(seal);
  assertBinding(binding);
  if (PROMOTION_AUTHORIZATION_BINDINGS.has(seal) || CONSUMED_PROMOTION_AUTHORIZATIONS.has(seal)) {
    throw new Error("PROMOTION_AUTHORIZATION_ALREADY_BOUND");
  }
  PROMOTION_AUTHORIZATION_BINDINGS.set(seal, Object.freeze({ ...binding }));
  return true;
}

/** 消费授权；绑定不符或已消费均抛错，保证不可转移/不可重放。 */
export function consumePromotionAuthorization(
  seal: PromotionSeal,
  binding: PromotionAuthorizationBinding
): true {
  assertPromotionSeal(seal);
  assertBinding(binding);
  const bound = PROMOTION_AUTHORIZATION_BINDINGS.get(seal);
  if (bound === undefined) throw new Error("PROMOTION_AUTHORIZATION_MISSING");
  if (!sameBinding(bound, binding)) throw new Error("PROMOTION_AUTHORIZATION_BINDING_MISMATCH");
  if (CONSUMED_PROMOTION_AUTHORIZATIONS.has(seal)) {
    throw new Error("PROMOTION_AUTHORIZATION_CONSUMED");
  }
  CONSUMED_PROMOTION_AUTHORIZATIONS.add(seal);
  return true;
}

export function isPromotionAuthorizationConsumed(value: unknown): boolean {
  return isRecord(value) && CONSUMED_PROMOTION_AUTHORIZATIONS.has(value);
}

/** 低阶 promote 系列在改动历史前必须确认授权尚未被消费。 */
export function assertPromotionAuthorizationReusable(seal: PromotionSeal): true {
  if (isPromotionAuthorizationConsumed(seal)) {
    throw new Error("PROMOTION_AUTHORIZATION_CONSUMED");
  }
  return true;
}
