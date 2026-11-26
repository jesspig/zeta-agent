/**
 * T-14 durable journal 与 T-17 SessionStore 共用的 unknown 词汇表。
 *
 * 只承诺 at-least-once + 幂等 adapter + unknown 对账；任何组件都不得把
 * 不确定结果表述为 exactly-once，也不得用 "成功/已跳过" 掩盖 unknown。
 */
export const DURABLE_UNKNOWN_VOCABULARY = {
  /** 不确定结果的唯一规范状态词（outbox/audit/journal 使用）。 */
  unknown: "unknown",
  /** SessionStore 的兼容状态名：语义与 unknown 相同，保留历史字符串以免破坏调用方。 */
  sessionUnknown: "unknown-outcome",
  /** 交付语义：仅 at-least-once。 */
  delivery: "at-least-once",
  /** adapter 必须幂等。 */
  adapter: "idempotent adapter",
  /** 不确定结果必须显式对账。 */
  reconciliation: "unknown 对账",
  /** 禁止出现的一次性交付措辞。 */
  forbiddenClaim: "exactly-once",
} as const;

export type DurableUnknownState = (typeof DURABLE_UNKNOWN_VOCABULARY)["unknown"];

/** 统一诊断文案：把不确定结果、交付语义与对账义务一次说清。 */
export function describeUnknownOutcome(prefix: string): string {
  return (
    `${prefix}：${DURABLE_UNKNOWN_VOCABULARY.unknown}；` +
    `${DURABLE_UNKNOWN_VOCABULARY.delivery} + ${DURABLE_UNKNOWN_VOCABULARY.adapter} + ` +
    `${DURABLE_UNKNOWN_VOCABULARY.reconciliation}；` +
    `不承诺 ${DURABLE_UNKNOWN_VOCABULARY.forbiddenClaim}`
  );
}
