/** 扩展来源；builtin 为随宿主发布的受控实现，其余均视为外部输入。 */
export type ExtensionOrigin =
  | "builtin"
  | "user"
  | "project"
  | "remote"
  | "generated"
  | (string & {});

/** 加载前可静态审查的来源、摘要与能力声明。 */
export interface ExtensionSource {
  readonly origin: ExtensionOrigin;
  readonly digest?: string;
  readonly capabilities?: readonly string[];
  readonly trusted?: boolean;
}

export interface ExtensionPolicy {
  readonly allowedCapabilities: readonly string[];
  readonly digestRequired: boolean;
  /** 不可信扩展的默认处置：deny（禁用）或 sandbox（降级沙箱）。 */
  readonly untrusted: "deny" | "sandbox";
}

export const DEFAULT_EXTENSION_POLICY: ExtensionPolicy = Object.freeze({
  allowedCapabilities: Object.freeze([
    "tools:read",
    "tools:write",
    "tools:shell",
    "events:on",
    "events:emit",
    "prompt:section",
    "tool:wrap",
    "task:run",
    "service:provide",
    "resources:read",
    "model:invoke",
    "effects:emit",
  ]),
  digestRequired: true,
  untrusted: "deny",
});

export type ExtensionDecision = "allowed" | "sandboxed" | "denied";

export interface ExtensionReview {
  readonly decision: ExtensionDecision;
  readonly reason: string;
  readonly source: ExtensionSource;
}

/**
 * 不可信扩展默认禁用；可信扩展仍需摘要与能力白名单审查。
 * 沙箱是显式策略选择，绝不因缺少 digest 或越权 capability 而自动放行。
 */
export function reviewExtension(
  source: ExtensionSource,
  policy: ExtensionPolicy = DEFAULT_EXTENSION_POLICY
): ExtensionReview {
  const review = (decision: ExtensionDecision, reason: string): ExtensionReview => ({ decision, reason, source });
  if (source.origin === "builtin") return review("allowed", "BUILTIN");

  const capabilities = source.capabilities ?? [];
  const forbidden = capabilities.filter((capability) => !policy.allowedCapabilities.includes(capability));
  if (forbidden.length > 0) return review("denied", `CAPABILITY_NOT_ALLOWED: ${forbidden.join(",")}`);

  if (policy.digestRequired && (typeof source.digest !== "string" || source.digest.length === 0)) {
    return review("denied", "DIGEST_REQUIRED");
  }
  if (source.trusted !== true) {
    return policy.untrusted === "sandbox"
      ? review("sandboxed", "UNTRUSTED_SANDBOXED")
      : review("denied", "UNTRUSTED_DISABLED");
  }
  return review("allowed", "TRUSTED");
}
