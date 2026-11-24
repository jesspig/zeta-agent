/**
 * 对象准入（IF-18）：principal / origin / grant 在 factory、route、admission 三处强制。
 *
 * 身份与隔离复用 T-13（Principal/RealmScoped）的结构，framework 不反向依赖 capabilities 以避免包环；
 * origin 的 scheme/host/pathSegments/method 与 T-14 credential binding 同构。
 * 默认 fail-closed：没有 grant、realm 不对齐、资源/动作未授权一律拒绝，且不保留任何对象值。
 */
export interface ObjectPrincipal {
  readonly userId: string;
  readonly spaceId: string;
  readonly realm: symbol;
}

export interface ObjectOrigin {
  readonly kind?: "runtime" | "facet" | "remote" | "user" | (string & {});
  readonly scheme?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pathSegments?: readonly string[];
  readonly method?: string;
}

export interface ObjectGrant {
  readonly id: string;
  readonly principal: ObjectPrincipal;
  readonly realm: symbol;
  readonly resources: readonly string[];
  readonly actions?: readonly string[];
  readonly origins?: readonly ObjectOrigin[];
}

export type AdmissionDenyReason =
  | "MISSING_PRINCIPAL"
  | "MISSING_GRANT"
  | "REALM_MISMATCH"
  | "PRINCIPAL_MISMATCH"
  | "RESOURCE_FORBIDDEN"
  | "ACTION_FORBIDDEN"
  | "ORIGIN_FORBIDDEN"
  | "GRANT_REVOKED";

export interface AdmissionContext {
  readonly principal?: ObjectPrincipal;
  readonly origin?: ObjectOrigin;
  readonly grant?: ObjectGrant;
  readonly resource?: string;
  readonly action?: string;
  readonly revokedGrants?: ReadonlySet<string>;
}

export type AdmissionDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: AdmissionDenyReason; readonly detail?: string };

export type AdmissionPolicy = (context: AdmissionContext) => AdmissionDecision;

/** 准入被拒：对象 state = denied，不保留值。 */
export class AdmissionError extends Error {
  readonly kind = "DENIED" as const;
  readonly reason: AdmissionDenyReason;

  constructor(reason: AdmissionDenyReason, message?: string) {
    super(message ?? `ADMISSION_DENIED: ${reason}`);
    this.name = "AdmissionError";
    this.reason = reason;
  }
}

const ALLOW: AdmissionDecision = Object.freeze({ kind: "allow" as const });

function deny(reason: AdmissionDenyReason, detail?: string): AdmissionDecision {
  return { kind: "deny", reason, detail };
}

function listAllows(allowed: readonly string[], value: string): boolean {
  return allowed.includes("*") || allowed.includes(value);
}

function originMatches(rule: ObjectOrigin, origin: ObjectOrigin): boolean {
  const pairs: ReadonlyArray<readonly [unknown, unknown]> = [
    [rule.kind, origin.kind],
    [rule.scheme, origin.scheme],
    [rule.host, origin.host],
    [rule.port, origin.port],
    [rule.method, origin.method === undefined ? undefined : origin.method.toUpperCase()],
  ];
  for (const [expected, actual] of pairs) {
    if (expected !== undefined && expected !== actual) return false;
  }
  if (rule.pathSegments !== undefined) {
    const actual = origin.pathSegments ?? [];
    if (rule.pathSegments.length > actual.length) return false;
    for (let index = 0; index < rule.pathSegments.length; index += 1) {
      if (rule.pathSegments[index] !== actual[index]) return false;
    }
  }
  return true;
}

/**
 * 判定准入：先跑不可绕过的默认 fail-closed 检查，再叠加 custom policy（只能进一步收紧）。
 * 返回 decision，绝不抛异常；调用方据此决定是否为对象保留值。
 */
export function decideAdmission(context: AdmissionContext, policy?: AdmissionPolicy): AdmissionDecision {
  const principal = context.principal;
  if (principal === undefined) return deny("MISSING_PRINCIPAL");
  const grant = context.grant;
  if (grant === undefined) return deny("MISSING_GRANT");
  if (grant.realm !== principal.realm || grant.principal.realm !== principal.realm) {
    return deny("REALM_MISMATCH");
  }
  if (
    grant.principal.userId !== principal.userId ||
    grant.principal.spaceId !== principal.spaceId
  ) {
    return deny("PRINCIPAL_MISMATCH");
  }
  if (context.revokedGrants?.has(grant.id) === true) return deny("GRANT_REVOKED");
  if (context.resource !== undefined && !listAllows(grant.resources, context.resource)) {
    return deny("RESOURCE_FORBIDDEN", context.resource);
  }
  if (
    context.action !== undefined &&
    grant.actions !== undefined &&
    !listAllows(grant.actions, context.action)
  ) {
    return deny("ACTION_FORBIDDEN", context.action);
  }
  if (grant.origins !== undefined && context.origin !== undefined) {
    if (!grant.origins.some((rule) => originMatches(rule, context.origin!))) {
      return deny("ORIGIN_FORBIDDEN");
    }
  }
  if (policy !== undefined) {
    const custom = policy(context);
    if (custom.kind === "deny") return custom;
  }
  return ALLOW;
}

/** 便于调用方以 decision 强制失败关闭。 */
export function assertAdmitted(decision: AdmissionDecision): void {
  if (decision.kind === "deny") throw new AdmissionError(decision.reason, decision.detail);
}

/** 便捷构造：由 principal 派生 grant（不新建 resolver，直接复用传入身份）。 */
export function grantFor(
  principal: ObjectPrincipal,
  resources: readonly string[],
  options: { readonly id?: string; readonly actions?: readonly string[]; readonly origins?: readonly ObjectOrigin[] } = {}
): ObjectGrant {
  return Object.freeze({
    id: options.id ?? `grant:${principal.spaceId}:${principal.userId}`,
    principal,
    realm: principal.realm,
    resources: [...resources],
    ...(options.actions === undefined ? {} : { actions: [...options.actions] }),
    ...(options.origins === undefined ? {} : { origins: [...options.origins] }),
  });
}

export const admission = decideAdmission;
