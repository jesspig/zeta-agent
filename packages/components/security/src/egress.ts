export interface EgressRule {
  readonly host: string;
  readonly port?: number;
}

export interface EgressTarget {
  readonly host: string;
  readonly port: number;
}

export interface EgressPolicy {
  readonly defaultAction: "deny";
  readonly allow: readonly EgressRule[];
  readonly denyAlways: readonly EgressRule[];
}

export interface EgressPolicyOptions {
  readonly allow?: readonly EgressRule[];
  readonly denyAlways?: readonly EgressRule[];
}

export function createEgressPolicy(options: EgressPolicyOptions = {}): EgressPolicy {
  return {
    defaultAction: "deny",
    allow: options.allow ?? [],
    denyAlways: options.denyAlways ?? [],
  };
}

function matches(rule: EgressRule, target: EgressTarget): boolean {
  return rule.host === target.host && (rule.port === undefined || rule.port === target.port);
}

export function isEgressAllowed(policy: EgressPolicy, target: EgressTarget): boolean {
  if (policy.denyAlways.some((rule) => matches(rule, target))) return false;
  return policy.allow.some((rule) => matches(rule, target));
}

export function assertEgressAllowed(policy: EgressPolicy, target: EgressTarget): void {
  if (!isEgressAllowed(policy, target)) throw new Error("EGRESS_DENIED");
}
