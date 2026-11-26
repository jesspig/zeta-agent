import { describe, expect, test } from "bun:test";
import { TARGETS } from "./targets";
import { LOCAL_BUILD_PLANS, buildPlanFor, hostTarget } from "./build-plan";

describe("T-20 12 target 构建计划", () => {
  test("每个 TARGET 都有唯一构建计划，且 bun target 与二进制名唯一", () => {
    expect(LOCAL_BUILD_PLANS).toHaveLength(12);
    expect(LOCAL_BUILD_PLANS.map((plan) => plan.target).sort()).toEqual([...TARGETS].sort());
    expect(new Set(LOCAL_BUILD_PLANS.map((plan) => plan.bunTarget)).size).toBe(12);
    expect(new Set(LOCAL_BUILD_PLANS.map((plan) => plan.binaryName)).size).toBe(12);
  });

  test("计划覆盖 os × arch × libc × baseline 的显式维度", () => {
    for (const plan of LOCAL_BUILD_PLANS) {
      expect(plan.bunTarget).toBe(`bun-${plan.os === "win32" ? "windows" : plan.os}-${plan.arch}${plan.libc === "musl" ? "-musl" : ""}${plan.baseline ? "-baseline" : ""}`);
      expect(plan.arch).toBe(plan.target.includes("arm64") ? "arm64" : "x64");
      expect(plan.target.split("-")[0]).toBe(plan.os);
      expect(plan.libc === "musl").toBe(plan.target.includes("musl"));
      expect(plan.baseline).toBe(plan.target.includes("baseline"));
      expect(plan.assets).toEqual([
        "arch-marker.zetaasset",
        "resource-catalog.zetaasset",
        "prompts/system.md",
        "skills/builtins/SKILL.md",
        "schema/config.zetaasset",
      ]);
    }
    expect(LOCAL_BUILD_PLANS.filter((plan) => plan.libc === "musl")).toHaveLength(2);
    expect(LOCAL_BUILD_PLANS.filter((plan) => plan.baseline)).toHaveLength(4);
  });

  test("buildPlanFor 拒绝未知 target", () => {
    expect(buildPlanFor("linux-x64").target).toBe("linux-x64");
    expect(() => buildPlanFor("plan9-x64")).toThrow(/target/i);
  });

  test("hostTarget 是当前平台的合法 target", () => {
    const host = hostTarget();
    if (host !== undefined) expect(() => buildPlanFor(host)).not.toThrow();
  });
});
