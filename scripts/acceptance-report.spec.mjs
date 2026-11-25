import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCEPTANCE_SCHEMA,
  CRITERION_VERSION,
  GENERATOR_VERSION,
  ITEM_IDS,
  applyAcceptedRisks,
  assertAcceptedRisksDoNotUpgrade,
  buildSummaryFromLogs,
  evaluateItem,
  exitCodeForReport,
  main,
  parseArgs,
  planPartialRerun,
  renderAcceptanceMarkdown,
  sha256Hex,
} from "./acceptance-report.mjs";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const TREE = "tree1234567890abcdef1234567890abcdef1234";

function context() {
  return {
    id: "zeta-acceptance-test-run",
    baseline: { ref: "feature/test", commit: HEAD, sourceTreeHash: TREE, worktreeClean: true },
    toolchain: { bun: "1.4.2", node: "22.0.0", packageManager: "bun@1.4.2" },
    generator: { version: GENERATOR_VERSION, sourceHash: "a".repeat(64) },
    criterionVersion: CRITERION_VERSION,
    generatedAt: "2026-11-26T00:00:00.000Z",
  };
}

function commandResult(overrides = {}) {
  return {
    argv: ["bun", "test", "fixture.spec.ts"],
    cwd: ".",
    exitCode: 0,
    signal: null,
    timedOut: false,
    log: { path: "reports/evidence/acceptance/run/fixture.0.log", sha256: "b".repeat(64), bytes: 16 },
    output: "PASS fixture exit=0\n",
    expected: true,
    ...overrides,
  };
}

function previousReport(readBytes) {
  const items = ITEM_IDS.map((id) => {
    const path = `reports/evidence/acceptance/run/${id}.0.log`;
    const bytes = readBytes(path);
    return {
      id,
      criterionVersion: CRITERION_VERSION,
      status: "pass",
      commands: [{ log: { path, sha256: sha256Hex(bytes), bytes: bytes.length } }],
      evidence: [path],
      summary: "PASS fixture exit=0",
      reasonCodes: [],
    };
  });
  return { schema: ACCEPTANCE_SCHEMA, run: context(), items };
}

function logReader() {
  const logs = new Map(ITEM_IDS.map((id) => [
    `reports/evidence/acceptance/run/${id}.0.log`,
    Buffer.from(`PASS ${id} exit=0\n`, "utf8"),
  ]));
  return (path) => {
    const bytes = logs.get(path);
    if (bytes === undefined) throw new Error(`missing log: ${path}`);
    return bytes;
  };
}

describe("T-01 acceptance v2 故障注入与退出码", () => {
  test("命令非零退出/标记缺失/超时/信号都判 fail", () => {
    const item = { id: "B1", title: "fixture" };
    const nonzero = evaluateItem(item, [commandResult({ exitCode: 7, output: "exit=7\n" })]);
    expect(nonzero.status).toBe("fail");
    expect(nonzero.reasonCodes.some((code) => code.startsWith("COMMAND_NONZERO_EXIT"))).toBe(true);

    const missing = evaluateItem(item, [commandResult({ expected: false })]);
    expect(missing.status).toBe("fail");
    expect(missing.reasonCodes.some((code) => code.startsWith("EXPECTED_MARKER_MISSING"))).toBe(true);

    const timeout = evaluateItem(item, [commandResult({ timedOut: true })]);
    expect(timeout.reasonCodes.some((code) => code.startsWith("COMMAND_TIMED_OUT"))).toBe(true);

    const signal = evaluateItem(item, [commandResult({ signal: "SIGKILL" })]);
    expect(signal.reasonCodes.some((code) => code.startsWith("COMMAND_SIGNAL"))).toBe(true);

    const blocked = evaluateItem(item, [commandResult({ spawnError: "ENOENT bun" })]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reasonCodes.some((code) => code.startsWith("COMMAND_SPAWN_ERROR"))).toBe(true);

    expect(evaluateItem(item, [commandResult()]).status).toBe("pass");
  });

  test("fail/blocked/unverified 退出码非零，ci fail 同样非零", () => {
    const base = { items: [{ status: "pass" }], ciEvidence: { result: "unverified" } };
    expect(exitCodeForReport(base)).toBe(0);
    expect(exitCodeForReport({ ...base, items: [{ status: "fail" }] })).toBe(1);
    expect(exitCodeForReport({ ...base, items: [{ status: "blocked" }] })).toBe(1);
    expect(exitCodeForReport({ ...base, items: [{ status: "unverified" }] })).toBe(1);
    expect(exitCodeForReport({ ...base, ciEvidence: { result: "fail" } })).toBe(1);
  });

  test("main 故障注入：报告与 Markdown 均来自本次日志，退出码为 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-acceptance-main-"));
    try {
      const logText = "PASS injected\nFAIL injected exit=7\n";
      const logPath = join(dir, "injected.log");
      writeFileSync(logPath, logText);
      const summary = buildSummaryFromLogs(logText);
      const injected = [{
        id: ITEM_IDS[0],
        criterionVersion: CRITERION_VERSION,
        status: "fail",
        commands: [{
          argv: ["bun", "test", "injected.spec.ts"],
          cwd: ".",
          exitCode: 7,
          signal: null,
          timedOut: false,
          log: { path: logPath, sha256: sha256Hex(Buffer.from(logText)), bytes: Buffer.byteLength(logText) },
        }],
        evidence: [logPath],
        summary,
        reasonCodes: ["COMMAND_NONZERO_EXIT:injected=7"],
      }];
      const plan = { mode: "full", reusedIds: [], rerunIds: [ITEM_IDS[0]], reasonCodes: [] };
      const code = await main([ITEM_IDS[0], "--run-id=test-run"], {
        root: dir,
        reportDir: dir,
        context: context(),
        plan,
        runAcceptanceFn: async () => injected,
      });
      expect(code).toBe(1);
      const report = JSON.parse(readFileSync(join(dir, "acceptance-report.json"), "utf8"));
      expect(report.schema).toBe(ACCEPTANCE_SCHEMA);
      expect(report.run.baseline.commit).toBe(HEAD);
      expect(report.items[0].status).toBe("fail");
      expect(report.items[0].commands[0].exitCode).toBe(7);
      expect(report.items[0].commands[0].log.sha256).toBe(sha256Hex(Buffer.from(logText)));
      expect(report.ciEvidence.result).toBe("unverified");
      const markdown = readFileSync(join(dir, "acceptance-report.md"), "utf8");
      for (const line of summary.split("\n")) expect(markdown).toContain(line);
      expect(markdown).toContain(report.run.baseline.commit);
      expect(readFileSync(logPath, "utf8")).toContain(summary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T-01 部分重跑拒绝过期基线/缺失哈希", () => {
  test("完全一致时允许 partial 复用", () => {
    const readBytes = logReader();
    const plan = planPartialRerun({
      ids: [ITEM_IDS[0]],
      previous: previousReport(readBytes),
      context: context(),
      readBytes,
    });
    expect(plan.mode).toBe("partial");
    expect(plan.rerunIds).toEqual([ITEM_IDS[0]]);
    expect(plan.reusedIds.length).toBe(ITEM_IDS.length - 1);
  });

  test("commit/sourceTreeHash/criterionVersion/generator 不一致时全量重跑", () => {
    const readBytes = logReader();
    const previous = previousReport(readBytes);
    const base = context();

    expect(planPartialRerun({
      ids: [ITEM_IDS[0]],
      previous: { ...previous, run: { ...base, baseline: { ...base.baseline, commit: "0".repeat(40) } } },
      context: base,
      readBytes,
    }).reasonCodes).toContain("PARTIAL_BASELINE_MISMATCH");

    expect(planPartialRerun({
      ids: [ITEM_IDS[0]],
      previous: { ...previous, run: { ...base, baseline: { ...base.baseline, sourceTreeHash: "0".repeat(40) } } },
      context: base,
      readBytes,
    }).reasonCodes).toContain("PARTIAL_SOURCE_TREE_HASH_MISMATCH");

    const wrongCriterion = {
      ...previous,
      items: previous.items.map((item, index) => index === 0
        ? { ...item, criterionVersion: "old-version" }
        : item),
    };
    expect(planPartialRerun({ ids: [ITEM_IDS[0]], previous: wrongCriterion, context: base, readBytes }).reasonCodes)
      .toContain("PARTIAL_CRITERION_VERSION_MISMATCH:A1");

    expect(planPartialRerun({
      ids: [ITEM_IDS[0]],
      previous: { ...previous, run: { ...base, generator: { version: "1.0.0", sourceHash: base.generator.sourceHash } } },
      context: base,
      readBytes,
    }).reasonCodes).toContain("PARTIAL_GENERATOR_MISMATCH");
  });

  test("旧日志哈希缺失或不匹配时全量重跑", () => {
    const readBytes = logReader();
    const previous = previousReport(readBytes);
    const base = context();

    const missing = {
      ...previous,
      items: previous.items.map((item, index) => index === 0
        ? { ...item, commands: [{ log: { path: item.commands[0].log.path } }] }
        : item),
    };
    expect(planPartialRerun({ ids: [ITEM_IDS[0]], previous: missing, context: base, readBytes }).reasonCodes
      .some((code) => code.startsWith("PARTIAL_LOG_HASH_MISSING"))).toBe(true);

    const mismatch = {
      ...previous,
      items: previous.items.map((item, index) => index === 0
        ? { ...item, commands: [{ log: { ...item.commands[0].log, sha256: "0".repeat(64) } }] }
        : item),
    };
    expect(planPartialRerun({ ids: [ITEM_IDS[0]], previous: mismatch, context: base, readBytes }).reasonCodes
      .some((code) => code.startsWith("PARTIAL_LOG_HASH_MISMATCH"))).toBe(true);

    const noIds = planPartialRerun({ ids: [], previous, context: base, readBytes });
    expect(noIds.mode).toBe("full");
    expect(noIds.rerunIds.length).toBe(ITEM_IDS.length);
  });
});

describe("T-01 Markdown 摘要与 acceptedRisk 边界", () => {
  test("摘要片段逐项来自同次日志并可定位", () => {
    const logText = "PASS A1\nFAIL A1 exit=3\n";
    const summary = buildSummaryFromLogs(logText);
    const report = {
      schema: ACCEPTANCE_SCHEMA,
      run: context(),
      ciEvidence: { result: "unverified", verifier: "ci-evidence/1", reasonCodes: [] },
      partialRerun: { mode: "full", reusedIds: [], rerunIds: [], reasonCodes: [] },
      items: [{
        id: ITEM_IDS[0],
        criterionVersion: CRITERION_VERSION,
        status: "fail",
        evidence: ["reports/evidence/acceptance/run/A1.0.log"],
        summary,
        reasonCodes: ["COMMAND_NONZERO_EXIT"],
      }],
    };
    const markdown = renderAcceptanceMarkdown(report);
    for (const line of summary.split("\n")) expect(markdown).toContain(line);
    expect(logText).toContain(summary);
  });

  test("accepted-risk 只记录，绝不把 A 项改成 pass", () => {
    const failItem = { id: ITEM_IDS[0], status: "fail", reasonCodes: [] };
    const withRisk = applyAcceptedRisks([failItem], [{ itemId: ITEM_IDS[0], reason: "known" }]);
    expect(withRisk[0].status).toBe("fail");
    expect(withRisk[0].reasonCodes).toContain("ACCEPTED_RISK_RECORDED");
    expect(applyAcceptedRisks([{ id: ITEM_IDS[1], status: "pass", reasonCodes: [] }], [{ itemId: ITEM_IDS[1] }])[0].status)
      .toBe("pass");
    expect(() => assertAcceptedRisksDoNotUpgrade([failItem], [{ id: ITEM_IDS[0], status: "pass" }])).toThrow();
  });

  test("位置参数选择与其他参数互不破坏", () => {
    const args = parseArgs([ITEM_IDS[0], ITEM_IDS[2], "--baseline=" + HEAD, "--ci-evidence=ci.json", "--run-id=r1"]);
    expect(args.ids).toEqual([ITEM_IDS[0], ITEM_IDS[2]]);
    expect(args.baseline).toBe(HEAD);
    expect(args.ciEvidence).toBe("ci.json");
    expect(args.runId).toBe("r1");
    expect(() => parseArgs(["NOT_AN_ITEM"])).toThrow();
    expect(parseArgs([]).ids).toEqual([]);
  });
});
