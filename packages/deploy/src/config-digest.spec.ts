import { describe, expect, test } from "bun:test";
import { computeStableConfigDigest, stripVolatileFields } from "./config-digest";
import { computeDaemonConfigDigest } from "./config-digest";
import { createRuntimeProbeSource, type AgentRuntimeLike } from "./runtime-probes";

function runtime(overrides: Partial<AgentRuntimeLike> = {}): AgentRuntimeLike {
  return {
    target: "linux-x64",
    rootFiber: { state: { kind: "ACTIVE" } } as AgentRuntimeLike["rootFiber"],
    profile: "local-safe",
    manifest: { profile: "local-safe", tools: ["read"] },
    protocol: { session: { id: "session-a" } },
    ...overrides,
  };
}

describe("T-16 稳定配置摘要", () => {
  test("相同配置跨 session / PID / 代次变化保持稳定", () => {
    const base = { target: "linux-x64", port: 4100, session: "s1", pid: 111, nested: { sessionId: "s1" } };
    const other = { target: "linux-x64", port: 4100, session: "s2", pid: 999, nested: { sessionId: "s2" } };
    expect(stripVolatileFields(base)).toEqual({
      target: "linux-x64",
      port: 4100,
      nested: {},
    });
    expect(computeStableConfigDigest(base)).toBe(computeStableConfigDigest(other));
    expect(computeStableConfigDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("稳定配置字段变化必然改变摘要", () => {
    const base = { target: "linux-x64", port: 4100, profile: "local-safe" };
    const digest = computeStableConfigDigest(base);
    expect(computeStableConfigDigest({ ...base, port: 4101 })).not.toBe(digest);
    expect(computeStableConfigDigest({ ...base, profile: "local-full" })).not.toBe(digest);
    expect(computeStableConfigDigest({ ...base, target: "darwin-arm64" })).not.toBe(digest);
  });

  test("runtime 探针摘要排除 session，daemon 摘要合并 deploy 配置", () => {
    const source = createRuntimeProbeSource(runtime());
    const sessionChanged = createRuntimeProbeSource(runtime({ protocol: { session: { id: "session-z" } } }));
    expect(source.configDigest()).toBe(sessionChanged.configDigest());

    const digest = computeDaemonConfigDigest({ target: "linux-x64", port: 4100 }, source.configDigest());
    expect(digest).toBe(computeDaemonConfigDigest({ port: 4100, target: "linux-x64" }, source.configDigest()));
    expect(computeDaemonConfigDigest({ target: "linux-x64", port: 4101 }, source.configDigest())).not.toBe(digest);
    expect(
      computeDaemonConfigDigest({ target: "linux-x64", port: 4100, session: "changed" }, source.configDigest())
    ).toBe(digest);
  });
});
