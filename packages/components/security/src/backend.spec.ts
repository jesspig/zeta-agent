import { describe, expect, test } from "bun:test";
import {
  assertEnforcement,
  createExecutionBackend,
  criticalLayerFailures,
  isCriticalLayerDegraded,
  type Capabilities,
  type Command,
} from "./backend";

function activeCapabilities(): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  };
}

describe("T-20 ExecutionBackend", () => {
  test("capabilities() 返回探测结果副本，不暴露内部可变引用", () => {
    const capabilities = activeCapabilities();
    const backend = createExecutionBackend({
      name: "inproc-vm",
      capabilities,
      executor: () => ({ exitCode: 0, stdout: "ok", stderr: "", isolated: null }),
    });

    const probed = backend.capabilities();
    expect(backend.name).toBe("inproc-vm");
    expect(probed).toEqual(capabilities);
    probed.isolation = "degraded";
    expect(backend.capabilities().isolation).toBe("active");
  });

  test("能力探测：关键层 degraded/unsupported 即 FAILED", () => {
    const capabilities = activeCapabilities();
    expect(criticalLayerFailures(capabilities)).toEqual([]);
    expect(isCriticalLayerDegraded(capabilities)).toBe(false);

    capabilities.seccomp = "degraded";
    expect(criticalLayerFailures(capabilities)).toEqual(["seccomp"]);
    expect(isCriticalLayerDegraded(capabilities)).toBe(true);
    expect(() => assertEnforcement(capabilities)).toThrow("CRITICAL_LAYER_DEGRADED");

    capabilities.isolation = "unsupported";
    expect(criticalLayerFailures(capabilities)).toEqual(["isolation", "seccomp"]);
  });

  test("关键层降级时 run() 拒绝执行，不调用 executor", async () => {
    let calls = 0;
    const capabilities = activeCapabilities();
    capabilities.fsConfinement = "degraded";
    const backend = createExecutionBackend({
      name: "bwrap-session",
      capabilities,
      executor: () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "", isolated: null };
      },
    });

    await expect(backend.run({ argv: ["echo", "hi"] })).rejects.toThrow("CRITICAL_LAYER_DEGRADED");
    expect(calls).toBe(0);
  });

  test("exec 隔离边界：run 只经注入 executor 并传递隔离 realm", async () => {
    const seen: Command[] = [];
    const backend = createExecutionBackend({
      name: "inproc-vm",
      capabilities: activeCapabilities(),
      executor: (command, options) => {
        seen.push(command);
        return {
          exitCode: 0,
          stdout: `ran:${command.argv.join(" ")}`,
          stderr: "",
          isolated: options?.realm ?? null,
        };
      },
    });

    const result = await backend.run({ argv: ["echo", "hi"] }, { realm: "tenant-a" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ran:echo hi");
    expect(result.isolated).toBe("tenant-a");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.argv).toEqual(["echo", "hi"]);
  });
});
