import { describe, expect, test } from "bun:test";
import {
  createExecutionBackend,
  criticalLayerFailures,
  isCriticalLayerDegraded,
  type Capabilities,
} from "./backend";

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
    ...overrides,
  };
}

/** CR-03：关键层 disabled 也是一种不可用，必须纳入失败判定。 */
describe("CR-03 关键层 disabled 失败关闭", () => {
  test("disabled 关键层被计入失败并触发降级判定", () => {
    expect(criticalLayerFailures(caps({ isolation: "disabled" }))).toContain("isolation");
    expect(isCriticalLayerDegraded(caps({ fsConfinement: "disabled" }))).toBe(true);
  });

  test("disabled 关键层的 backend.run 拒绝执行", async () => {
    let calls = 0;
    const backend = createExecutionBackend({
      name: "disabled-layer",
      capabilities: caps({ seccomp: "disabled" }),
      executor: () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "", isolated: null };
      },
    });
    await expect(backend.run({ argv: ["echo", "hi"] })).rejects.toThrow("CRITICAL_LAYER_DEGRADED");
    expect(calls).toBe(0);
  });
});
