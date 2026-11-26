import { computeConfigDigest } from "./canonical";

/**
 * 配置摘要中被排除的非稳定字段：每次启动/会话都会变化，不能进入"相同配置"的判定。
 * 稳定身份字段（profile / manifest / target / deploy config）必须保留。
 */
export const VOLATILE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "session",
  "sessionId",
  "sessionID",
  "pid",
  "processId",
  "processID",
  "generation",
  "startedAt",
  "startTime",
  "nonce",
  "leaseId",
]);

/** 递归剔除易变字段；不改变输入，Date/Map/Set 等由 canonical 编码器自行处理。 */
export function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripVolatileFields(item));
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (VOLATILE_CONFIG_KEYS.has(key)) continue;
    result[key] = stripVolatileFields(item);
  }
  return result;
}

/** 稳定配置摘要：相同配置恒定，不同配置必然变化，且与 session/PID 无关。 */
export function computeStableConfigDigest(config: Readonly<Record<string, unknown>>): string {
  return computeConfigDigest(stripVolatileFields(config) as Record<string, unknown>);
}

/** daemon 身份摘要：合并 deploy 配置与 runtime 探针摘要，排除所有易变字段。 */
export function computeDaemonConfigDigest(
  deploy: Readonly<Record<string, unknown>>,
  runtimeDigest: string
): string {
  return computeStableConfigDigest({ deploy, runtime: runtimeDigest });
}
