import { describe, expect, test } from "bun:test";
import { evaluatePluginSource, pluginSystemSandbox } from "./isolated-evaluator";
import { createPluginSource } from "./plugin-source";

describe("T-20 / F-T13-01 插件隔离系统沙箱如实标注", () => {
  test("Windows 平台明确平台受限，禁止声明 active 或合成 marker", () => {
    const support = pluginSystemSandbox("win32");
    expect(support.state).toBe("unsupported");
    expect(support.platformLimited).toBe(true);
    expect(support.mechanism).toBeNull();
    expect(support.reason).toContain("PLATFORM_LIMITED");
  });

  test("其它平台未接入真实沙箱时同样 unsupported，不写 active", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const support = pluginSystemSandbox(platform);
      expect(support.state).toBe("unsupported");
      expect(support.mechanism).toBeNull();
    }
  });

  test("隔离报告携带系统沙箱事实，与 child-vm 顶层执行路径并存但不冒充系统沙箱", async () => {
    const source = createPluginSource("sandbox-report-fixture", 'api.addSection("local fixture");', {
      trusted: false,
    });
    const plugin = await evaluatePluginSource(source);
    try {
      expect(plugin.report.topLevelExecution).toBe("child-vm");
      expect(plugin.report.systemSandbox.state).toBe("unsupported");
      expect(plugin.report.systemSandbox.platform).toBe(process.platform);
      expect(plugin.report.systemSandbox.mechanism).toBeNull();
    } finally {
      await plugin.terminate();
    }
  });
});
