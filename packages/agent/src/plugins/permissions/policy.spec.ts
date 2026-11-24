import { describe, expect, test } from "bun:test";
import {
  evaluatePermissionPolicy,
  type PermissionEffect,
  type PermissionPolicy,
} from "./policy";

const subject = { stage: "plan", tool: "probe" } as const;

function rule(
  effect: PermissionEffect,
  reason?: string,
  bypassImmune = false
): PermissionPolicy {
  return { kind: "rule", rule: { effect, reason, bypassImmune, stage: "plan", tool: "probe" } };
}

describe("T-08 PermissionPolicy AST", () => {
  test("restrict is monotonic deny under every permutation of two effects", () => {
    const effects: readonly PermissionEffect[] = ["PASSTHROUGH", "ALLOW", "ASK", "DENY"];
    const rank: Record<PermissionEffect, number> = { PASSTHROUGH: 0, ALLOW: 1, ASK: 2, DENY: 3 };
    for (const first of effects) {
      for (const second of effects) {
        const forward = evaluatePermissionPolicy({ kind: "restrict", of: [rule(first), rule(second)] }, subject);
        const reverse = evaluatePermissionPolicy({ kind: "restrict", of: [rule(second), rule(first)] }, subject);
        expect(forward.behavior).toBe(reverse.behavior);
        expect(rank[forward.behavior]).toBe(Math.max(rank[first], rank[second]));
      }
    }
  });

  test("override elevates a normal deny but never a bypass-immune deny", () => {
    const base = { kind: "restrict" as const, of: [rule("DENY", "normal-deny")] };
    const elevated = evaluatePermissionPolicy(
      { kind: "override", base, effect: "ALLOW", reason: "explicit-allow" },
      subject
    );
    expect(elevated.behavior).toBe("ALLOW");
    expect(elevated.reason).toBe("explicit-allow");

    const immune = { kind: "restrict" as const, of: [rule("DENY", "critical", true)] };
    const blocked = evaluatePermissionPolicy(
      { kind: "override", base: immune, effect: "ALLOW" },
      subject
    );
    expect(blocked.behavior).toBe("DENY");
  });

  test("fallback applies only when the base is PASSTHROUGH", () => {
    const unmatched: PermissionPolicy = {
      kind: "rule",
      rule: { effect: "ALLOW", stage: "build", tool: "probe" },
    };
    expect(evaluatePermissionPolicy({ kind: "fallback", base: unmatched, effect: "DENY", reason: "default-deny" }, subject).behavior).toBe("DENY");
    const matched = { kind: "restrict" as const, of: [rule("ASK", "confirm")] };
    const kept = evaluatePermissionPolicy({ kind: "fallback", base: matched, effect: "ALLOW" }, subject);
    expect(kept.behavior).toBe("ASK");
    expect(kept.reason).toBe("confirm");
  });

  test("non-matching rules are PASSTHROUGH and do not weaken a deny", () => {
    const policy: PermissionPolicy = {
      kind: "restrict",
      of: [
        { kind: "rule", rule: { effect: "ALLOW", stage: "build", tool: "probe" } },
        { kind: "rule", rule: { effect: "DENY", reason: "blocked", stage: "plan", tool: "probe" } },
      ],
    };
    expect(evaluatePermissionPolicy(policy, subject).behavior).toBe("DENY");
  });
});
