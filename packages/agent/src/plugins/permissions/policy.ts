import type {
  PermissionBehavior,
  PermissionVerdict,
} from "@zeta-agent/agent-framework";

export type PermissionEffect = PermissionBehavior;

/** 策略作用对象：facade 在 beforeToolCall 阶段把 stage/tool/args 交给 AST 求值。 */
export interface PermissionSubject {
  readonly stage: string;
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface PermissionPolicyRule {
  readonly effect: PermissionBehavior;
  readonly stage?: string | readonly string[];
  readonly tool?: string | readonly string[];
  readonly reason?: string;
  /** 为 true 时连 override 也不能提升该拒绝（安全关键层）。 */
  readonly bypassImmune?: boolean;
}

export type PermissionPolicy =
  | { readonly kind: "rule"; readonly rule: PermissionPolicyRule }
  | { readonly kind: "restrict"; readonly of: readonly PermissionPolicy[] }
  | { readonly kind: "override"; readonly base: PermissionPolicy; readonly effect: PermissionBehavior; readonly reason?: string }
  | { readonly kind: "fallback"; readonly base: PermissionPolicy; readonly effect: PermissionBehavior; readonly reason?: string };

const RANK: Readonly<Record<PermissionBehavior, number>> = {
  PASSTHROUGH: 0,
  ALLOW: 1,
  ASK: 2,
  DENY: 3,
};

function matches(value: string, expected: string | readonly string[] | undefined): boolean {
  if (expected === undefined) return true;
  return typeof expected === "string" ? value === expected : expected.includes(value);
}

function ruleVerdict(rule: PermissionPolicyRule, subject: PermissionSubject): PermissionVerdict {
  if (!matches(subject.stage, rule.stage) || !matches(subject.tool, rule.tool)) {
    return { behavior: "PASSTHROUGH" };
  }
  return {
    behavior: rule.effect,
    ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
    ...(rule.bypassImmune === true ? { bypassImmune: true } : {}),
  };
}

function stricter(left: PermissionVerdict, right: PermissionVerdict): PermissionVerdict {
  if (RANK[right.behavior] > RANK[left.behavior]) return right;
  if (RANK[left.behavior] > RANK[right.behavior]) return left;
  // 同级保留带 reason 的一侧，保证拒绝原因不被静默丢弃。
  return right.reason !== undefined ? right : left;
}

/** AST 求值：restrict 单调收紧；override 仅能提升非 bypass-immune 结果；fallback 只补 PASSTHROUGH。 */
export function evaluatePermissionPolicy(
  policy: PermissionPolicy,
  subject: PermissionSubject
): PermissionVerdict {
  switch (policy.kind) {
    case "rule":
      return ruleVerdict(policy.rule, subject);
    case "restrict": {
      let winner: PermissionVerdict = { behavior: "PASSTHROUGH" };
      for (const child of policy.of) winner = stricter(winner, evaluatePermissionPolicy(child, subject));
      return winner;
    }
    case "override": {
      const base = evaluatePermissionPolicy(policy.base, subject);
      if (base.behavior === "DENY" && base.bypassImmune === true) return base;
      if (policy.effect === "PASSTHROUGH") return base;
      return {
        behavior: policy.effect,
        ...(policy.reason !== undefined ? { reason: policy.reason } : { ...(base.reason !== undefined ? { reason: base.reason } : {}) }),
      };
    }
    case "fallback": {
      const base = evaluatePermissionPolicy(policy.base, subject);
      if (base.behavior !== "PASSTHROUGH") return base;
      return { behavior: policy.effect, ...(policy.reason !== undefined ? { reason: policy.reason } : {}) };
    }
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

/** 把多条策略合并为单调 restrict 节点，便于组合插件贡献。 */
export function combinePermissionPolicies(policies: readonly PermissionPolicy[]): PermissionPolicy {
  return { kind: "restrict", of: [...policies] };
}
