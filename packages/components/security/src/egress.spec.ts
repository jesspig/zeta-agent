import { describe, expect, test } from "bun:test";
import {
  assertEgressAllowed,
  createEgressPolicy,
  isEgressAllowed,
} from "./egress";

describe("T-21 egress", () => {
  test("默认拒绝：仅白名单目标放行", () => {
    const policy = createEgressPolicy({ allow: [{ host: "api.example.com", port: 443 }] });
    expect(policy.defaultAction).toBe("deny");
    expect(isEgressAllowed(policy, { host: "api.example.com", port: 443 })).toBe(true);
    expect(isEgressAllowed(policy, { host: "unknown.example", port: 443 })).toBe(false);
  });

  test("端口不匹配即拒绝", () => {
    const policy = createEgressPolicy({ allow: [{ host: "api.example.com", port: 443 }] });
    expect(isEgressAllowed(policy, { host: "api.example.com", port: 80 })).toBe(false);
  });

  test("平台 denyAlways 压过用户 allow", () => {
    const policy = createEgressPolicy({
      allow: [{ host: "169.254.169.254", port: 80 }],
      denyAlways: [{ host: "169.254.169.254", port: 80 }],
    });
    expect(isEgressAllowed(policy, { host: "169.254.169.254", port: 80 })).toBe(false);
  });

  test("assertEgressAllowed 拒绝时抛 EGRESS_DENIED", () => {
    const policy = createEgressPolicy({ allow: [{ host: "api.example.com", port: 443 }] });
    expect(() => assertEgressAllowed(policy, { host: "evil.example", port: 443 })).toThrow("EGRESS_DENIED");
    expect(() => assertEgressAllowed(policy, { host: "api.example.com", port: 443 })).not.toThrow();
  });
});
