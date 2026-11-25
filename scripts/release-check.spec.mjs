import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ROOT,
  collectSkippedTargets,
  hostTargetLocal,
  verifyRunbook,
  verifySbomShape,
  versionFromSource,
} from "./release-check.mjs";
import { verifyCapabilityMatrix } from "./check-capability-matrix.mjs";
import { verifyFactRegistry } from "./check-fact-registry.mjs";
import { verifyApiStubs } from "./check-api-stubs.mjs";
import { verifyGrpcWire } from "./check-grpc-wire.mjs";

describe("T-27 发布候选校验辅助函数", () => {
  test("版本来自真实 CLI 源码且宿主 target 可解析", () => {
    expect(versionFromSource()).toBe("0.1.0");
    expect(hostTargetLocal()).toMatch(/^(win32|linux|darwin)-(x64|arm64)$/);
  });

  test("SBOM 结构校验读取真实报告", () => {
    const result = verifySbomShape(join(ROOT, "reports/sbom.json"));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("components=");
  });

  test("迁移与回滚说明包含安装/升级/回滚与校验命令", () => {
    expect(verifyRunbook(join(ROOT, "docs/desgin/delivery/release-runbook.md")).ok).toBe(true);
  });

  test("平台报告中的非宿主 target 标记为 skipped，宿主为 pass", () => {
    const result = collectSkippedTargets(join(ROOT, "reports/gates-platform.json"), hostTargetLocal());
    expect(result.hostPass).toBe(true);
    expect(result.skipped.length).toBe(11);
  });

  test("能力矩阵装配清单与 builtin 注册表一致", () => {
    const result = verifyCapabilityMatrix();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("装配清单一致");
  });

  test("事实登记 P1-P10 指向真实文件与测试", () => {
    expect(verifyFactRegistry().ok).toBe(true);
  });

  test("公开 API 源码无 NOT_IMPLEMENTED 类未实现标记", () => {
    expect(verifyApiStubs().ok).toBe(true);
  });

  test("remote 具备 wire-level gRPC proto 与 server/client 桩", () => {
    const result = verifyGrpcWire();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("wire-level gRPC");
  });
});
