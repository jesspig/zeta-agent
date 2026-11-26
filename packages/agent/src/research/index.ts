// 研究轨公开出口；seal.ts 的签发函数与 promotion.ts 的低阶 promote 系列有意不导出，
// 底层晋升/评估原语只能经 pipeline 的一次性授权调用。
export * from "./frozen";
export * from "./decision";
export {
  assertObservationEquivalence,
  assertPromotionInvariants,
  CONTEXT_KEY_OPERATIONS,
  contextFingerprint,
  matchesArtifactDigest,
  sha256Hex,
  type Candidate,
  type DigestPromotionOptions,
  type ObservationContext,
  type ObservationPromotionOptions,
  type PromotionArtifact,
  type PromotionDecision,
  type PromotionRejectionReason,
  type PromotionState,
} from "./promotion";
export * from "./experience";
export * from "./fitness";
export * from "./pipeline";
export * from "./orchestration";
export * from "./seal-registry";
