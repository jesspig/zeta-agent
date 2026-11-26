import { describe, expect, test } from "bun:test";
import {
  BACKEND_PROFILES,
  OperationNames,
  criticalLayerFailures,
  isStructuredExecutionBackend,
  operationState,
  profileSupport,
  type BackendProfile,
  type NodePlatform,
} from "./backend";
import { createProfileBackend } from "./backend.local-safe";

/** T-09：平台能力矩阵必须诚实声明；沙箱类后端在不支持的平台明确失败关闭。 */
describe("T-09 后端支持矩阵", () => {
  const sandboxProfiles: readonly BackendProfile[] = [
    "inproc-vm",
    "bwrap-session",
    "container",
    "remote",
    "microvm",
  ];

  test("BACKEND_PROFILES 覆盖 local-safe 与四个沙箱档位", () => {
    expect([...BACKEND_PROFILES].sort()).toEqual(
      [...sandboxProfiles, "local-safe", "local-full"].sort() as BackendProfile[]
    );
  });

  test("Windows 下所有沙箱档位的隔离/seccomp 都不是 active", () => {
    for (const profile of sandboxProfiles) {
      const support = profileSupport(profile, "win32" as NodePlatform);
      expect(support.capabilities.isolation, profile).not.toBe("active");
      expect(support.capabilities.seccomp, profile).not.toBe("active");
      expect(criticalLayerFailures(support.capabilities).length, profile).toBeGreaterThan(0);
    }
  });

  test("未接真实执行器的沙箱档位在任何平台都不伪装 active", () => {
    for (const platform of ["win32", "linux", "darwin"] as NodePlatform[]) {
      for (const profile of sandboxProfiles) {
        const support = profileSupport(profile, platform);
        expect(support.capabilities.isolation, `${profile}@${platform}`).not.toBe("active");
        expect(support.reason, `${profile}@${platform}`).toBeTruthy();
      }
    }
  });

  test("local-safe 声明真实文件边界 active，但进程隔离 unsupported", () => {
    const support = profileSupport("local-safe", "win32" as NodePlatform);
    expect(support.capabilities.fsConfinement).toBe("active");
    expect(support.capabilities.isolation).toBe("unsupported");
    expect(support.capabilities.seccomp).toBe("unsupported");
    expect(operationState(support.operations, "file.read")).toBe("active");
    expect(operationState(support.operations, "file.write")).toBe("active");
    expect(operationState(support.operations, "shell.start")).toBe("unsupported");
  });

  test("沙箱 profile backend 在 Windows 所有结构化操作失败关闭且无宿主副作用", async () => {
    for (const profile of sandboxProfiles) {
      const backend = createProfileBackend(profile, { platform: "win32" as NodePlatform });
      expect(isStructuredExecutionBackend(backend), profile).toBe(true);
      for (const op of OperationNames) {
        expect(operationState(backend.operations, op), `${profile}/${op}`).not.toBe("active");
      }
      const read = await backend.file.read("C:\\anything\\secret.txt");
      expect(read.ok, profile).toBe(false);
      if (!read.ok) expect(read.code, profile).toBe("OPERATION_UNAVAILABLE");
      await expect(backend.run({ argv: ["echo", "hi"] })).rejects.toThrow(/CRITICAL_LAYER_DEGRADED/);
    }
  });
});
