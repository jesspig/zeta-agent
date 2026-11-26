import { createHash } from "node:crypto";

/**
 * 插件的「源码表示」：以字符串 + 摘要 + 信任级别为输入，而不是宿主 JS 对象。
 *
 * 该表示是隔离求值的入口：不可信源码必须先经过摘要校验，随后在独立子进程中求值，
 * 宿主永不 eval/Function/vm 执行 source。宿主侧拿到的只有可 JSON 序列化的贡献描述。
 */
export interface PluginSource {
  readonly kind: "PluginSource";
  /** 插件名；同时作为贡献 owner 与审查归因。 */
  readonly name: string;
  /** 待求值的顶层 JS 源码（compat 风格：通过 bridge 注册贡献）。 */
  readonly source: string;
  /** 期望摘要，格式 `sha256:<64 hex>`；求值前强制校验。 */
  readonly digest: string;
  /** 信任级别：true 才允许宿主注册可执行项；false 仅数据型贡献。 */
  readonly trusted: boolean;
  readonly version?: string;
  readonly origin?: string;
  readonly capabilities?: readonly string[];
  /** 资源上限；缺省见 DEFAULT_EVALUATE_LIMITS。 */
  readonly limits?: EvaluateLimits;
}

/** 求值/调用的资源上限。CPU 用 vm timeout，内存用子进程 max-old-space-size。 */
export interface EvaluateLimits {
  /** 顶层求值超时（ms）。 */
  readonly timeoutMs?: number;
  /** 单次 handler 调用超时（ms）。 */
  readonly invokeTimeoutMs?: number;
  /** 子进程 stdout 单行/总量上限（bytes）。 */
  readonly maxOutputBytes?: number;
  /** 接受的贡献数量上限。 */
  readonly maxContributions?: number;
  /** 接受的源码长度上限（characters）。 */
  readonly maxSourceChars?: number;
  /** 子进程老生代内存上限（MB）；作为 execArgv 传入。 */
  readonly maxOldSpaceMb?: number;
}

export const DEFAULT_EVALUATE_LIMITS: EvaluateLimits = Object.freeze({
  timeoutMs: 2000,
  invokeTimeoutMs: 2000,
  maxOutputBytes: 1024 * 1024,
  maxContributions: 200,
  maxSourceChars: 256 * 1024,
  maxOldSpaceMb: 128,
});

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 计算源码摘要；与 verifyPluginSourceDigest 使用同一实现。 */
export function pluginSourceDigest(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

/**
 * 求值前校验：格式非法、长度非法、摘要不匹配一律立即拒绝。
 * 该函数在宿主侧执行，只处理字符串，绝不执行 source。
 */
export function verifyPluginSourceDigest(
  source: PluginSource,
  limits: EvaluateLimits = DEFAULT_EVALUATE_LIMITS
): void {
  if (source === null || typeof source !== "object") throw new Error("PLUGIN_SOURCE_INVALID");
  if (typeof source.source !== "string") throw new Error("PLUGIN_SOURCE_INVALID");
  if (typeof source.digest !== "string") throw new Error("PLUGIN_DIGEST_INVALID");
  if (!DIGEST_PATTERN.test(source.digest)) throw new Error("PLUGIN_DIGEST_INVALID_FORMAT");
  if (typeof source.name !== "string" || source.name.length === 0) throw new Error("PLUGIN_SOURCE_NAME_INVALID");
  const maxChars = limits.maxSourceChars ?? DEFAULT_EVALUATE_LIMITS.maxSourceChars!;
  if (source.source.length === 0 || source.source.length > maxChars) throw new Error("PLUGIN_SOURCE_LENGTH_INVALID");
  if (pluginSourceDigest(source.source) !== source.digest) throw new Error("PLUGIN_DIGEST_MISMATCH");
}

/** 从源码构建 PluginSource：摘要由实现计算，避免调用方伪造。 */
export function createPluginSource(
  name: string,
  source: string,
  options: {
    readonly trusted?: boolean;
    readonly version?: string;
    readonly origin?: string;
    readonly capabilities?: readonly string[];
    readonly limits?: EvaluateLimits;
  } = {}
): PluginSource {
  return {
    kind: "PluginSource",
    name,
    source,
    digest: pluginSourceDigest(source),
    trusted: options.trusted === true,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}
