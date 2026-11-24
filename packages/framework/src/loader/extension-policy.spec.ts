import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXTENSION_POLICY,
  reviewExtension,
  type ExtensionSource,
  type ExtensionPolicy,
} from "./extension-policy";

const trustedSource: ExtensionSource = {
  origin: "user",
  digest: "sha256:abc123",
  capabilities: ["tools:read", "events:on"],
  trusted: true,
};

describe("T-16 不可信扩展的来源/digest/capability 审查", () => {
  test("builtin 来源默认允许", () => {
    expect(reviewExtension({ origin: "builtin" }).decision).toBe("allowed");
  });

  test("不可信扩展默认禁用（denied），不进入执行路径", () => {
    expect(reviewExtension({ origin: "remote", digest: "sha256:x" }).decision).toBe("denied");
    expect(reviewExtension({ ...trustedSource, trusted: false }).decision).toBe("denied");
  });

  test("可信扩展缺 digest 仍拒绝", () => {
    expect(reviewExtension({ ...trustedSource, digest: undefined }).decision).toBe("denied");
  });

  test("capability 超出允许集时拒绝（能力审查）", () => {
    const decision = reviewExtension({
      ...trustedSource,
      capabilities: ["tools:read", "fs:write"],
    });
    expect(decision.decision).toBe("denied");
    expect(decision.reason).toContain("fs:write");
  });

  test("可信且 digest/能力齐备时允许", () => {
    expect(reviewExtension(trustedSource).decision).toBe("allowed");
  });

  test("策略可将不可信扩展降级为沙箱而非直接拒绝", () => {
    const sandboxPolicy: ExtensionPolicy = {
      ...DEFAULT_EXTENSION_POLICY,
      untrusted: "sandbox",
    };
    expect(reviewExtension({ origin: "generated", digest: "sha256:g" }, sandboxPolicy).decision).toBe("sandboxed");
  });
});
