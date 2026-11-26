import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact";
import { collectTargetEvidence, emulateStartupFromArtifact, type LoadedArtifact } from "./target-evidence";
import { TARGETS } from "./targets";

function fixture(target: string): ArtifactManifest {
  const marker = new Uint8Array(20);
  marker.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
  new DataView(marker.buffer).setUint16(18, target.includes("arm64") ? 0xb7 : 0x3e, true);
  const catalog = new TextEncoder().encode("fixture-catalog");
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return {
    version: 1,
    target: target as ArtifactManifest["target"],
    binary: { arch: target.includes("arm64") ? "arm64" : "x64", path: "zeta", bytes: 0 },
    embedded: [
      { id: "arch-marker", kind: "native", arch: target.includes("arm64") ? "arm64" : "x64", path: "arch-marker.zetaasset", bytes: marker.byteLength, sha256: sha(marker) },
      { id: "resource-catalog", kind: "data", arch: "universal", path: "resource-catalog.zetaasset", bytes: catalog.byteLength, sha256: sha(catalog) },
    ],
  };
}

function artifact(target: string): LoadedArtifact {
  const manifest = fixture(target);
  return {
    target,
    manifest,
    embedded: {
      "arch-marker": new Uint8Array([
        0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        target.includes("arm64") ? 0xb7 : 0x3e, 0,
      ]),
      "resource-catalog": new TextEncoder().encode("fixture-catalog"),
    },
  };
}

describe("T-24 12 target 构建/运行矩阵", () => {
  test("构建矩阵与运行矩阵分开，只有宿主为 native/pass", () => {
    const matrix = collectTargetEvidence({
      host: "linux-x64",
      loadArtifact: (target) => artifact(target),
      runNative: () => ({ code: 0, stdout: "zeta 0.1.0", probe: true }),
      now: () => "2026-11-26T00:00:00Z",
    });
    expect(matrix.build).toHaveLength(12);
    expect(matrix.run).toHaveLength(12);
    expect(matrix.build.every((item) => item.kind === "cross-build/static" && item.native === false)).toBe(true);
    const native = matrix.run.filter((item) => item.native);
    expect(native).toHaveLength(1);
    expect(native[0]!.target).toBe("linux-x64");
    expect(native[0]!.status).toBe("pass");
    for (const item of matrix.run.filter((entry) => !entry.native)) {
      expect(item.mode).toBe("emulated");
      expect(item.status).toBe("emulated");
      expect(item.emulated).toBe(true);
      expect(item.proof).toBe("emulated:artifact-bytes");
    }
    expect(matrix.summary.run).toMatchObject({ native: 1, emulated: 11, skipped: 0, fail: 0 });
  });

  test("无产物为 skipped，绝不写成 pass 或 emulated", () => {
    const matrix = collectTargetEvidence({
      host: "win32-x64",
      loadArtifact: (target) => (target === "win32-x64" ? artifact(target) : undefined),
      runNative: () => ({ code: 0, stdout: "zeta 0.1.0", probe: true }),
      emulationSource: false,
    });
    expect(matrix.run.filter((item) => item.status === "skipped")).toHaveLength(11);
    for (const item of matrix.run.filter((entry) => entry.status === "skipped")) {
      expect(item.mode).toBe("none");
      expect(item.native).toBe(false);
      expect(item.emulated).toBe(false);
    }
  });

  test("仿真基于真实 bytes 逐项校验且永不返回 pass/native", () => {
    const item = artifact("linux-arm64");
    const emulated = emulateStartupFromArtifact(item.manifest, item.embedded, { target: "linux-arm64" });
    expect(emulated.status).toBe("emulated");
    expect(emulated.mode).toBe("emulated");
    expect(emulated.native).toBe(false);
    expect(emulated.checks.filter((check) => check.id.startsWith("embedded:")).map((check) => check.status)).toEqual(["pass", "pass"]);
    const corrupted = { ...item.embedded, "resource-catalog": new TextEncoder().encode("tampered") };
    expect(emulateStartupFromArtifact(item.manifest, corrupted).status).toBe("fail");
  });

  test("宿主启动探针失败记 fail，不伪造 pass", () => {
    const matrix = collectTargetEvidence({
      host: "linux-x64",
      loadArtifact: (target) => artifact(target),
      runNative: () => ({ code: 1, stdout: "", stderr: "boom", probe: false }),
    });
    expect(matrix.run.find((item) => item.target === "linux-x64")?.status).toBe("fail");
    expect(matrix.run.some((item) => item.status === "pass")).toBe(false);
  });

  test("12 target 与部署清单一一对应", () => {
    const matrix = collectTargetEvidence({ loadArtifact: () => undefined, emulationSource: false });
    expect(matrix.build.map((item) => item.target)).toEqual([...TARGETS]);
    expect(matrix.run.map((item) => item.target)).toEqual([...TARGETS]);
  });

  test("无原生产物的非宿主 target 使用源码真实 bytes 仿真，构建仍为 skipped", () => {
    const matrix = collectTargetEvidence({
      host: "win32-x64",
      loadArtifact: (target) => (target === "win32-x64" ? artifact(target) : undefined),
      runNative: () => ({ code: 0, stdout: "zeta 0.1.0", probe: true }),
      emulationSource: (target) => artifact(target),
    });
    const other = matrix.run.filter((item) => item.target !== "win32-x64");
    expect(other).toHaveLength(11);
    expect(other.every((item) => item.status === "emulated" && item.emulated && !item.native)).toBe(true);
    expect(other.every((item) => item.proof === "emulated:source-asset-bytes")).toBe(true);
    expect(matrix.build.filter((item) => item.status === "skipped")).toHaveLength(11);
    expect(matrix.summary.build.pass).toBe(1);
  });
});
