import { describe, expect, test } from "bun:test";
import {
  createUnconnectedBackend,
  criticalLayerFailures,
  isCriticalLayerDegraded,
} from "./backend";

/** 能力一致性：占位后端没接真实执行器，就不得声明 active。 */
describe("占位后端能力声明与实际一致", () => {
  test("未接真实执行器时 capabilities() 全部声明 unsupported 且返回副本", () => {
    const backend = createUnconnectedBackend();
    const caps = backend.capabilities();

    expect(caps).toEqual({
      isolation: "unsupported",
      seccomp: "unsupported",
      fsConfinement: "unsupported",
      auditSink: "unsupported",
      egressDefaultDeny: "unsupported",
    });
    expect(criticalLayerFailures(caps)).toEqual(["isolation", "seccomp", "fsConfinement"]);
    expect(isCriticalLayerDegraded(caps)).toBe(true);

    caps.isolation = "active";
    expect(backend.capabilities().isolation).toBe("unsupported");
  });

  test("run() 在能力探测阶段即失败关闭，不伪造执行成功", async () => {
    const backend = createUnconnectedBackend({
      name: "no-real-exec",
      reason: "NO_REAL_EXECUTION_BACKEND",
    });

    await expect(backend.run({ argv: ["echo", "hi"] })).rejects.toThrow("CRITICAL_LAYER_DEGRADED");
  });
});
