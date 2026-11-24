import { describe, expect, test } from "bun:test";
import type { AgentRuntimeLike } from "@zeta-agent/deploy";
import { createProbeHandle, handleProbeFrame, PROBE_NAMES } from "./probes";

function runtime(kind: string): AgentRuntimeLike {
  return {
    target: "linux-x64",
    rootFiber: { state: { kind } } as AgentRuntimeLike["rootFiber"],
    profile: "local-safe",
    manifest: { profile: "local-safe", tools: ["read"] },
    protocol: { session: { id: "rpc-probe" } },
  };
}

describe("T-20 --rpc 运行探针帧", () => {
  test("三种探针都返回真实值，而不是静态占位", () => {
    const handle = createProbeHandle(runtime("ACTIVE"), { target: "linux-x64" });
    for (const probe of PROBE_NAMES) {
      const line = JSON.stringify({ type: "probe", probe });
      const result = handleProbeFrame(handle, line);
      expect(result).toBeDefined();
      const frame = JSON.parse(result!);
      expect(frame.type).toBe("probe.result");
      expect(frame.probe).toBe(probe);
      if (probe === "configDigest") expect(frame.value).toMatch(/^[0-9a-f]{64}$/);
      else expect(frame.value).toBe(true);
    }
    handle.stop();
    const dead = JSON.parse(handleProbeFrame(handle, JSON.stringify({ type: "probe", probe: "liveness" }))!);
    expect(dead.value).toBe(false);
  });

  test("非探针帧与未知探针不会伪装成控制协议结果", () => {
    const handle = createProbeHandle(runtime("ACTIVE"), { target: "linux-x64" });
    expect(handleProbeFrame(handle, JSON.stringify({ type: "control", action: "prompt", text: "hi" }))).toBeUndefined();
    expect(handleProbeFrame(handle, "not-json")).toBeUndefined();
    const unknown = JSON.parse(handleProbeFrame(handle, JSON.stringify({ type: "probe", probe: "unknown" }))!);
    expect(unknown.error).toBe("UNKNOWN_PROBE");
  });
});
