import { describe, expect, test } from "bun:test";
import { assertTarget, TARGETS, validateTarget, verifyBinaryArch } from "./targets";

describe("T-28 target matrix and binary architecture validation", () => {
  test("TARGETS contains exactly 12 distinct canonical targets", () => {
    expect(TARGETS).toHaveLength(12);
    expect(new Set(TARGETS).size).toBe(12);
    expect(Object.isFrozen(TARGETS)).toBe(true);
  });

  test("TARGETS covers linux, darwin and win32 on x64 and arm64", () => {
    const operatingSystems = new Set(TARGETS.map((target) => target.split("-")[0]));
    expect([...operatingSystems].sort()).toEqual(["darwin", "linux", "win32"]);
    for (const arch of ["x64", "arm64"]) {
      expect(TARGETS.some((target) => target.includes(arch))).toBe(true);
    }
  });

  test("validateTarget accepts every declared target and rejects illegal strings", () => {
    for (const target of TARGETS) expect(validateTarget(target)).toBe(true);
    const illegal = [
      "",
      "linux",
      "linux-x64-glibc-extra",
      "plan9-x64",
      "LINUX-X64",
      "linux-x64-glibc",
      "linux-mips-glibc",
      "darwin-x64-evil",
    ];
    for (const target of illegal) expect(validateTarget(target)).toBe(false);
  });

  test("assertTarget throws on an illegal target", () => {
    expect(() => assertTarget("linux-x64")).not.toThrow();
    expect(() => assertTarget("plan9-x64")).toThrow(/target/i);
  });

  test("verifyBinaryArch rejects embedded resources built for another architecture", () => {
    expect(() => verifyBinaryArch({ arch: "x64", embedded: ["x64", "x64"] }, "linux-x64")).not.toThrow();
    expect(() => verifyBinaryArch({ arch: "x64", embedded: ["arm64"] }, "linux-x64")).toThrow(/arch/i);
    expect(() => verifyBinaryArch({ arch: "arm64", embedded: ["arm64"] }, "darwin-arm64")).not.toThrow();
    expect(() => verifyBinaryArch({ arch: "arm64", embedded: ["x64"] }, "darwin-arm64")).toThrow(/arch/i);
  });
});
