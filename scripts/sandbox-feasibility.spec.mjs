import { describe, expect, test } from "bun:test";
import { probeSandboxFeasibility } from "./sandbox-feasibility.mjs";

describe("T-24 / F-T13-01 系统级沙箱可行性结论", () => {
  test("维持 unsupported/platformLimited/closure=unmet，且给出可复核事实", () => {
    const report = probeSandboxFeasibility(process.cwd(), {
      hostTarget: "win32-x64",
      jobPowerShell: { reachable: true, detail: "out-of-process-only" },
      inProcessApi: { childProcess: false, global: false },
      runners: { wsl: false, bwrap: false, seccomp: false },
      wslDistros: 0,
      packagedIdentity: false,
      now: () => "2026-11-26T00:00:00Z",
    });
    expect(report.state).toBe("unsupported");
    expect(report.platformLimited).toBe(true);
    expect(report.closure).toBe("unmet");
    expect(report.evidence.nativeAddonCount).toBeGreaterThanOrEqual(0);
    const reasons = report.reasons.join(" ");
    expect(reasons).toContain("NO_IN_PROCESS_SYSTEM_SANDBOX_API");
    expect(reasons).toContain("OUT_OF_PROCESS_ONLY");
    expect(reasons).toContain("NO_APP_CONTAINER_IDENTITY");
    expect(reasons).toContain("NO_LINUX_RUNNER");
    expect(report.disposition).toContain("T-25");
  });
});
