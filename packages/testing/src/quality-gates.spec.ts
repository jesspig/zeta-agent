import { describe, expect, test } from "bun:test";
import {
  assertAuthenticityBaseline,
  assertReportAcceptable,
  checkReleaseAges,
  evaluatePerf,
  parseSbomFromLockfile,
  renderMarkdown,
  scanAuthenticity,
  summarizeReport,
  type GateResult,
  type QualityReport,
} from "./quality-gates";

function gate(
  id: string,
  category: GateResult["category"],
  status: GateResult["status"],
  scope: GateResult["scope"] = "local"
): GateResult {
  return {
    id,
    category,
    name: id,
    status,
    scope,
    detail: "detail",
    evidence: [],
  };
}

function report(gates: readonly GateResult[]): QualityReport {
  return {
    schema: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    environment: { platform: "win32", arch: "x64", bun: "1.4.2" },
    gates,
  };
}

describe("T-26 quality gate report model", () => {
  test("汇总按状态与类别计数", () => {
    const summary = summarizeReport(
      report([
        gate("a", "tests", "pass"),
        gate("b", "tests", "fail"),
        gate("c", "platform", "skipped"),
        gate("d", "platform", "skipped"),
        gate("e", "supply-chain", "unverified"),
      ])
    );
    expect(summary.total).toBe(5);
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.unverified).toBe(1);
    expect(summary.byCategory.platform.skipped).toBe(2);
  });

  test("本地门失败或本地门未通过时必须拒绝；跨环境门允许 skipped", () => {
    expect(() => assertReportAcceptable(report([gate("ok", "tests", "pass")]))).not.toThrow();
    expect(() =>
      assertReportAcceptable(report([gate("cross", "platform", "skipped", "cross-platform")]))
    ).not.toThrow();
    expect(() => assertReportAcceptable(report([gate("bad", "tests", "fail")]))).toThrow(
      /GATE_FAILED/
    );
    expect(() => assertReportAcceptable(report([gate("local", "tests", "skipped")]))).toThrow(
      /GATE_NOT_PASSED/
    );
    expect(() =>
      assertReportAcceptable(report([gate("cross", "platform", "unverified", "network")]))
    ).not.toThrow();
  });

  test("报告渲染包含每个门的状态与汇总", () => {
    const markdown = renderMarkdown(report([gate("unit", "tests", "pass")]));
    expect(markdown).toContain("unit");
    expect(markdown).toContain("pass");
    expect(markdown).toContain("总计");
  });
});

describe("T-26 test authenticity scan", () => {
  const files = [
    {
      path: "a.spec.ts",
      content: `import { createX } from "@zeta-agent/agent";
test("x", async () => { await createX(); expect(1).toBe(1); });`,
    },
    {
      path: "b.spec.ts",
      content: `test("p", async () => { await Promise.all([f(), g()]); expect(1).toBe(1); });
rmSync(path, { recursive: true });`,
    },
    {
      path: "c.spec.ts",
      content: `test("fake", () => { const f = mock(() => 1); });`,
    },
    {
      path: "d.spec.ts",
      content: `test("time", async () => { setSystemTime(0); await tick(); expect(1).toBe(1); });`,
    },
  ];

  test("从真实源码文本统计公共 API、真实异步、并行与故障注入标记", () => {
    const scan = scanAuthenticity(files);
    expect(scan.files).toBe(4);
    expect(scan.publicApiImports).toBe(1);
    expect(scan.realAsyncFiles).toBe(3);
    expect(scan.parallelFiles).toBe(1);
    expect(scan.faultInjectionFiles).toBe(1);
    expect(scan.mockOnlyFiles).toBe(1);
    expect(scan.fakeTimerFiles).toBe(1);
  });

  test("公共 API 扫描兼容单引号与多层相对 index 导入", () => {
    const scan = scanAuthenticity([
      {
        path: "public-api.spec.ts",
        content: "import { createX } from '@zeta-agent/agent';\nimport { createY } from '../../src/index';",
      },
    ]);
    expect(scan.publicApiImports).toBe(1);
  });

  test("基线是棘轮：只允许增长，mock-only 必须为零", () => {
    const current = scanAuthenticity(files.slice(0, 2));
    expect(() =>
      assertAuthenticityBaseline(current, {
        files: 1,
        publicApiImports: 1,
        realAsyncFiles: 2,
        parallelFiles: 1,
        faultInjectionFiles: 1,
        mockOnlyFiles: 0,
        fakeTimerFiles: 0,
      })
    ).not.toThrow();
    expect(() =>
      assertAuthenticityBaseline(current, {
        files: 1,
        publicApiImports: 1,
        realAsyncFiles: 2,
        parallelFiles: 1,
        faultInjectionFiles: 1,
        mockOnlyFiles: 1,
        fakeTimerFiles: 0,
      })
    ).toThrow(/MOCK_ONLY/);
    expect(() =>
      assertAuthenticityBaseline(scanAuthenticity([]), {
        files: 0,
        publicApiImports: 1,
        realAsyncFiles: 0,
        parallelFiles: 0,
        faultInjectionFiles: 0,
        mockOnlyFiles: 0,
        fakeTimerFiles: 0,
      })
    ).toThrow(/AUTHENTICITY_BASELINE/);
  });
});

describe("T-26 SBOM 与供应链门", () => {
  test("从真实 bun.lock 结构提取带完整性摘要的组件", () => {
    const lock = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "@scope/pkg": [
          "@scope/pkg@1.2.3",
          "",
          { dependencies: { dep: "^2.0.0" } },
          "sha512-abc",
        ],
        dep: ["dep@2.0.0", "", {}, "sha512-def"],
      },
    });
    const sbom = parseSbomFromLockfile(lock);
    expect(sbom.components).toHaveLength(2);
    expect(sbom.components[0]).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
      integrity: "sha512-abc",
      kind: "library",
    });
    expect(() => parseSbomFromLockfile("not json")).toThrow(/SBOM_/);
    expect(() =>
      parseSbomFromLockfile(
        JSON.stringify({ lockfileVersion: 2, packages: { broken: ["broken@1.0.0", "", {}] } })
      )
    ).toThrow(/SBOM_INTEGRITY_MISSING/);
  });

  test("release-age 只对有真实发布时间的组件计数", () => {
    const result = checkReleaseAges(
      [
        { name: "old", version: "1.0.0", publishedAt: "2020-01-01T00:00:00.000Z" },
        { name: "new", version: "2.0.0", publishedAt: "2026-12-01T00:00:00.000Z" },
        { name: "unknown", version: "3.0.0", publishedAt: null },
      ],
      new Date("2026-11-25T00:00:00.000Z"),
      7
    );
    expect(result.checked).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.tooNew).toEqual(["new@2.0.0"]);
  });
});

describe("T-26 性能预算", () => {
  const budget = {
    maxFirstFrameMs: 100,
    maxEffectMs: 100,
    maxReloadMs: 100,
    maxGuardWaitMs: 100,
    maxLongSessionMs: 100,
    maxMemBytes: 1000,
    maxTokenCost: 100,
  };

  test("逐项比较实测值与阈值并指出超限项", () => {
    const results = evaluatePerf(
      {
        firstFrameMs: 10,
        effectMs: 20,
        reloadMs: 30,
        guardWaitMs: 40,
        longSessionMs: 50,
        memBytes: 900,
        tokenCost: 90,
      },
      budget
    );
    expect(results).toHaveLength(7);
    expect(results.every((item) => item.ok)).toBe(true);
    const exceeded = evaluatePerf(
      {
        firstFrameMs: 101,
        effectMs: 20,
        reloadMs: 30,
        guardWaitMs: 40,
        longSessionMs: 50,
        memBytes: 900,
        tokenCost: 90,
      },
      budget
    );
    expect(exceeded.filter((item) => !item.ok).map((item) => item.name)).toEqual(["firstFrameMs"]);
    expect(() =>
      evaluatePerf(
        {
          firstFrameMs: Number.NaN,
          effectMs: 20,
          reloadMs: 30,
          guardWaitMs: 40,
          longSessionMs: 50,
          memBytes: 900,
          tokenCost: 90,
        },
        budget
      )
    ).toThrow(/PERF_METRIC_INVALID/);
  });
});
