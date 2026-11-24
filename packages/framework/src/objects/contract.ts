/** contract 的品牌标记：仅 defineContract 可填入，外部无法伪造。 */
export declare const contractBrand: unique symbol;

export interface Contract<P = unknown, M = unknown> {
  readonly [contractBrand]: true;
  readonly name: string;
  readonly version: string;
  readonly params: P;
  readonly members: M;
  /** 版本映射：旧版本 -> 当前版本；映射失败即 FAILED。 */
  readonly accepts: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

export interface ContractSpec<P, M> {
  readonly name: string;
  readonly version: string;
  readonly params: P;
  readonly members: M;
  readonly accepts?: Record<string, string>;
}

export type ContractFailureReason = "FORGED_CONTRACT" | "VERSION_MISMATCH" | "FINGERPRINT_MISMATCH";

/** contract 校验失败：对应 fiber 的 FAILED 状态，不把错版本数据喂给消费者。 */
export class ContractError extends Error {
  readonly kind = "FAILED" as const;
  readonly reason: ContractFailureReason;

  constructor(reason: ContractFailureReason, message: string) {
    super(message);
    this.name = "ContractError";
    this.reason = reason;
  }
}

const REGISTRY = new WeakSet<object>();

/** 稳定序列化：键排序，忽略 undefined，作为规范化哈希与等价比较的基础。 */
export function canonicalString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalString).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalString(obj[key])}`).join(",")}}`;
}

/** FNV-1a 32 位规范化哈希，纯 JS，不依赖运行时或节点内建模块。 */
export function hashValue(value: unknown): string {
  const input = canonicalString(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** fingerprint = 对契约身份（name/version/params/members）的规范化哈希。 */
export function computeFingerprint(
  spec: Pick<ContractSpec<unknown, unknown>, "name" | "version" | "params" | "members">
): string {
  return hashValue({
    name: spec.name,
    version: spec.version,
    params: spec.params,
    members: spec.members,
  });
}

export function defineContract<P, M>(spec: ContractSpec<P, M>): Contract<P, M> {
  const contract = {
    name: spec.name,
    version: spec.version,
    params: spec.params,
    members: spec.members,
    accepts: Object.freeze({ ...(spec.accepts ?? {}) }),
    fingerprint: computeFingerprint(spec),
  } as unknown as Contract<P, M>;
  REGISTRY.add(contract);
  return Object.freeze(contract);
}

export function isContract(value: unknown): value is Contract<any, any> {
  return typeof value === "object" && value !== null && REGISTRY.has(value);
}

export function assertContract(value: unknown): asserts value is Contract<any, any> {
  if (!isContract(value)) {
    throw new ContractError("FORGED_CONTRACT", "伪造或非法的 contract 句柄");
  }
}

/** 指纹不符即 FAILED：不覆写数据、不把错版本数据喂给消费者。 */
export function assertFingerprint(contract: Contract<any, any>, expected: string): void {
  assertContract(contract);
  if (contract.fingerprint !== expected) {
    throw new ContractError("FINGERPRINT_MISMATCH", `contract "${contract.name}" 指纹不符`);
  }
}

/**
 * 版本协商：完全相等或通过 accepts 映射相等即接受；否则 FAILED。
 * 返回被接受的版本号。
 */
export function acceptVersion(contract: Contract<any, any>, offeredVersion: string): string {
  assertContract(contract);
  if (offeredVersion === contract.version) return contract.version;
  const mapped = contract.accepts[offeredVersion];
  if (mapped !== undefined && mapped === contract.version) return contract.version;
  throw new ContractError(
    "VERSION_MISMATCH",
    `contract "${contract.name}" 不接受版本 ${offeredVersion}`
  );
}
