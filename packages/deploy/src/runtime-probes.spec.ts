import { describe, expect, test } from "bun:test";
import { createDefaultRuntime } from "@zeta-agent/agent";
import { start } from "./deployment";
import { computeConfigDigest } from "./canonical";
import { createRuntimeProbeSource, type AgentRuntimeLike } from "./runtime-probes";

function fakeRuntime(kind: string, overrides: Partial<AgentRuntimeLike> = {}): AgentRuntimeLike {
  return {
    target: "linux-x64",
    rootFiber: { state: { kind } } as AgentRuntimeLike["rootFiber"],
    profile: "local-safe",
    manifest: { profile: "local-safe", tools: ["read"] },
    protocol: { session: { id: "probe-session" } },
    ...overrides,
  };
}

describe("T-20 运行探针接入真实 AgentRuntime", () => {
  test("readiness/liveness 直接读取 runtime fiber 状态，不是本地布尔缓存", () => {
    const source = createRuntimeProbeSource(fakeRuntime("ACTIVE"));
    expect(source.liveness()).toBe(true);
    expect(source.readiness()).toBe(true);

    const loading = createRuntimeProbeSource(fakeRuntime("LOADING"));
    expect(loading.liveness()).toBe(true);
    expect(loading.readiness()).toBe(false);

    const disposed = createRuntimeProbeSource(fakeRuntime("DISPOSED"));
    expect(disposed.liveness()).toBe(false);
    expect(disposed.readiness()).toBe(false);

    const failed = createRuntimeProbeSource(fakeRuntime("FAILED"));
    expect(failed.liveness()).toBe(false);
    expect(failed.readiness()).toBe(false);
  });

  test("configDigest 包含稳定 profile / manifest / target，排除 session/PID 等非稳定字段", () => {
    const base = createRuntimeProbeSource(fakeRuntime("ACTIVE")).configDigest();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(createRuntimeProbeSource(fakeRuntime("ACTIVE", { profile: "local-full" })).configDigest()).not.toBe(base);
    expect(
      createRuntimeProbeSource(fakeRuntime("ACTIVE", { manifest: { profile: "local-safe", tools: ["read", "bash"] } })).configDigest()
    ).not.toBe(base);
    expect(createRuntimeProbeSource(fakeRuntime("ACTIVE", { target: "darwin-arm64" })).configDigest()).not.toBe(base);
    // T-16：相同配置的摘要必须跨 session / PID 变化保持稳定。
    expect(
      createRuntimeProbeSource(
        fakeRuntime("ACTIVE", { protocol: { session: { id: "another-session" } } })
      ).configDigest()
    ).toBe(base);
    expect(createRuntimeProbeSource(fakeRuntime("ACTIVE")).configDigest()).toBe(base);
  });

  test("start 接受 runtime 源并拒绝 target 不一致", () => {
    const handle = start("local", { target: "linux-x64" }, {
      runtime: createRuntimeProbeSource(fakeRuntime("ACTIVE")),
    });
    expect(handle.liveness()).toBe(true);
    expect(handle.readiness()).toBe(true);
    handle.stop();
    expect(handle.readiness()).toBe(false);
    expect(handle.liveness()).toBe(false);

    expect(() =>
      start("local", { target: "darwin-arm64" }, { runtime: createRuntimeProbeSource(fakeRuntime("ACTIVE")) })
    ).toThrow(/target/i);
  });

  test("start 的 configDigest 合并部署配置与 runtime 摘要，无歧义", () => {
    const source = createRuntimeProbeSource(fakeRuntime("ACTIVE"));
    const handle = start("local", { target: "linux-x64", port: 4100 }, { runtime: source });
    expect(handle.configDigest()).toBe(computeConfigDigest({ deploy: { target: "linux-x64", port: 4100 }, runtime: source.configDigest() }));
    handle.updateConfig({ target: "linux-x64", port: 4101 });
    expect(handle.configDigest()).not.toBe(computeConfigDigest({ deploy: { target: "linux-x64", port: 4100 }, runtime: source.configDigest() }));
  });

  test("真实 createDefaultRuntime 就绪后探针为 true，dispose 后 liveness 为 false", async () => {
    const runtime = await createDefaultRuntime({ profile: "local-safe", sessionId: "t20-probe" });
    const source = createRuntimeProbeSource(runtime);
    expect(source.readiness()).toBe(true);
    expect(source.liveness()).toBe(true);
    await runtime.dispose();
    expect(source.readiness()).toBe(false);
    expect(source.liveness()).toBe(false);
  });
});
