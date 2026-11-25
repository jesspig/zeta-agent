import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS } from "../packages/deploy/src/index.ts";
import {
  ROOT,
  RELEASE_SCHEMA,
  buildReport,
  collectReleaseBaseline,
  collectSkippedTargets,
  exitCodeForReleaseReport,
  hostTargetLocal,
  parseReleaseArgs,
  renderMarkdown,
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

  test("SBOM 结构校验读取生成的报告", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-sbom-"));
    try {
      const components = Array.from({ length: 120 }, (_, index) => ({
        name: `fixture-${index}`,
        version: "1.0.0",
        integrity: `sha512-${"a".repeat(128)}`,
      }));
      const path = join(dir, "sbom.json");
      writeFileSync(path, JSON.stringify({ schema: "zeta-sbom-1", components }));
      const result = verifySbomShape(path);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("components=120");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("迁移与回滚说明包含安装/升级/回滚与校验命令", () => {
    expect(verifyRunbook(join(ROOT, "docs/desgin/delivery/release-runbook.md")).ok).toBe(true);
  });

  test("平台报告中的非宿主 target 标记为 skipped，宿主为 pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-platform-"));
    try {
      const host = hostTargetLocal();
      const path = join(dir, "gates-platform.json");
      writeFileSync(path, JSON.stringify(TARGETS.map((target) => ({
        id: `platform:${target}`,
        status: target === host ? "pass" : "skipped",
      }))));
      const result = collectSkippedTargets(path, host);
      expect(result.hostPass).toBe(true);
      expect(result.skipped.length).toBe(11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("T-01 release v2 绑定 baseline 与 source tree", () => {
  const HEAD = "1234567890abcdef1234567890abcdef12345678";
  const TREE = "tree1234567890abcdef1234567890abcdef1234";

  function fakeGit() {
    return (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return `${HEAD}\n`;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/release\n";
      if (args[0] === "rev-parse" && args[1].endsWith("^{tree}")) return `${TREE}\n`;
      if (args[0] === "status") return "\n";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    };
  }

  test("显式 baseline 与 git 实测 tree 写入绑定字段", () => {
    const baseline = collectReleaseBaseline({ baselineArg: HEAD, runGit: fakeGit() });
    expect(baseline.commit).toBe(HEAD);
    expect(baseline.sourceTreeHash).toBe(TREE);
    expect(baseline.worktreeClean).toBe(true);
    expect(parseReleaseArgs(["--baseline=" + HEAD, "--run-id=rr"])).toEqual({ baseline: HEAD, runId: "rr" });
  });

  test("未传 baseline 时从 HEAD 实测，不伪造当前 commit", () => {
    expect(collectReleaseBaseline({ runGit: fakeGit() }).commit).toBe(HEAD);
  });

  test("buildReport 与 Markdown 均包含 baseline/tree/runId/buildCommand", async () => {
    const report = await buildReport(ROOT, {
      baselineArg: HEAD,
      runIdArg: "release-run-1",
      runGit: fakeGit(),
      now: () => new Date("2026-11-26T01:02:03.000Z"),
      buildCommand: "bun run build",
    });
    expect(report.schema).toBe(RELEASE_SCHEMA);
    expect(report.baselineCommit).toBe(HEAD);
    expect(report.sourceTreeHash).toBe(TREE);
    expect(report.runId).toBe("release-run-1");
    expect(report.buildCommand).toBe("bun run build");
    expect(report.worktreeClean).toBe(true);
    expect(report.generatedAt).toBe("2026-11-26T01:02:03.000Z");
    const markdown = renderMarkdown(report);
    expect(markdown).toContain(HEAD);
    expect(markdown).toContain(TREE);
    expect(markdown).toContain("release-run-1");
    expect(markdown).toContain("bun run build");
  });

  test("fail 汇总退出码非零", () => {
    expect(exitCodeForReleaseReport({ summary: { fail: 1 } })).toBe(1);
    expect(exitCodeForReleaseReport({ summary: { fail: 0 } })).toBe(0);
  });
});
