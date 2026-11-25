/**
 * T-26 质量门报告模型与去伪扫描。纯函数：所有 I/O 由 scripts/gate-*.mjs 在系统边界完成。
 */

export type GateStatus = "pass" | "fail" | "skipped" | "unverified";
export type GateCategory =
  | "tests"
  | "performance"
  | "security"
  | "platform"
  | "supply-chain"
  | "authenticity";
/** local 门必须在当前机器通过；cross-platform/network 门可如实标记 skipped 或 unverified。 */
export type GateScope = "local" | "cross-platform" | "network";

export interface GateEvidence {
  readonly kind: "command" | "file" | "measurement" | "config";
  readonly ref: string;
}

export interface GateResult {
  readonly id: string;
  readonly category: GateCategory;
  readonly name: string;
  readonly status: GateStatus;
  readonly scope: GateScope;
  readonly detail: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly evidence: readonly GateEvidence[];
}

export interface QualityReport {
  readonly schema: number;
  readonly generatedAt: string;
  readonly environment: {
    readonly platform: string;
    readonly arch: string;
    readonly bun: string;
  };
  readonly gates: readonly GateResult[];
}

export interface GateSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly unverified: number;
  readonly byCategory: Readonly<
    Record<GateCategory, { pass: number; fail: number; skipped: number; unverified: number }>
  >;
}

const CATEGORIES: readonly GateCategory[] = [
  "tests",
  "performance",
  "security",
  "platform",
  "supply-chain",
  "authenticity",
];

function emptyCounts(): { pass: number; fail: number; skipped: number; unverified: number } {
  return { pass: 0, fail: 0, skipped: 0, unverified: 0 };
}

export function summarizeReport(report: QualityReport): GateSummary {
  const byCategory = Object.fromEntries(CATEGORIES.map((name) => [name, emptyCounts()])) as Record<
    GateCategory,
    { pass: number; fail: number; skipped: number; unverified: number }
  >;
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  let unverified = 0;
  for (const item of report.gates) {
    byCategory[item.category][item.status] += 1;
    if (item.status === "pass") pass += 1;
    else if (item.status === "fail") fail += 1;
    else if (item.status === "skipped") skipped += 1;
    else unverified += 1;
  }
  return { total: report.gates.length, pass, fail, skipped, unverified, byCategory };
}

/** 失败门一律拒绝；本地门未明确 pass 也拒绝，避免 skipped 掩盖回归。 */
export function assertReportAcceptable(report: QualityReport): void {
  for (const item of report.gates) {
    if (item.status === "fail") throw new Error(`GATE_FAILED: ${item.id}: ${item.detail}`);
    if (item.status !== "pass" && item.scope === "local") {
      throw new Error(`GATE_NOT_PASSED: ${item.id}: ${item.detail}`);
    }
    if (item.status !== "pass" && item.detail.trim() === "") {
      throw new Error(`GATE_REASON_MISSING: ${item.id}`);
    }
  }
}

export function renderMarkdown(report: QualityReport): string {
  const summary = summarizeReport(report);
  const lines = [
    "# 全量质量门报告",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 环境：${report.environment.platform}/${report.environment.arch} · bun ${report.environment.bun}`,
    `- 总计：${summary.total} 个门；pass ${summary.pass} / fail ${summary.fail} / skipped ${summary.skipped} / unverified ${summary.unverified}`,
    "",
    "| 类别 | 门 | 状态 | 范围 | 说明 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of report.gates) {
    lines.push(
      `| ${item.category} | ${item.id} | ${item.status} | ${item.scope} | ${item.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`
    );
  }
  lines.push("", "## 分类汇总", "");
  for (const category of CATEGORIES) {
    const value = summary.byCategory[category];
    lines.push(
      `- ${category}: pass ${value.pass} / fail ${value.fail} / skipped ${value.skipped} / unverified ${value.unverified}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export interface TestSource {
  readonly path: string;
  readonly content: string;
}

export interface AuthenticityScan {
  readonly files: number;
  readonly publicApiImports: number;
  readonly realAsyncFiles: number;
  readonly parallelFiles: number;
  readonly faultInjectionFiles: number;
  readonly mockOnlyFiles: number;
  readonly fakeTimerFiles: number;
}

const PUBLIC_API = /from\s+["'](@zeta-agent\/[\w-]+|(?:^|\/)\.\.\/(?:src\/)?index)["']/;
const REAL_ASYNC = /\bawait\s/;
const PARALLEL = /\b(?:Promise\.(?:all|allSettled)|Bun\.spawn|spawnSync|new Worker|worker_threads)\b/;
const FAULT_INJECTION =
  /\b(?:rmSync|unlinkSync|truncateSync|kill\s*\(|SIGKILL|SIGTERM|crash|corrupt)\b/i;
const MOCK = /\bmock\s*\(/;
const EXPECT = /\bexpect\s*\(/;
const FAKE_TIMER = /\b(?:setSystemTime|useFakeTimers)\s*\(/;

/** 对测试源码文本做静态去伪扫描；不执行测试，仅统计可核查的真实性标记。 */
export function scanAuthenticity(sources: readonly TestSource[]): AuthenticityScan {
  const result = {
    files: sources.length,
    publicApiImports: 0,
    realAsyncFiles: 0,
    parallelFiles: 0,
    faultInjectionFiles: 0,
    mockOnlyFiles: 0,
    fakeTimerFiles: 0,
  };
  for (const source of sources) {
    const content = source.content;
    if (PUBLIC_API.test(content)) result.publicApiImports += 1;
    if (REAL_ASYNC.test(content)) result.realAsyncFiles += 1;
    if (PARALLEL.test(content)) result.parallelFiles += 1;
    if (FAULT_INJECTION.test(content)) result.faultInjectionFiles += 1;
    if (MOCK.test(content) && !EXPECT.test(content)) result.mockOnlyFiles += 1;
    if (FAKE_TIMER.test(content)) result.fakeTimerFiles += 1;
  }
  return result;
}

export type AuthenticityBaseline = AuthenticityScan;

/** 棘轮：所有正向标记只允许不低于基线；mock-only 必须为零。 */
export function assertAuthenticityBaseline(
  current: AuthenticityScan,
  baseline: AuthenticityBaseline
): void {
  for (const key of [
    "files",
    "publicApiImports",
    "realAsyncFiles",
    "parallelFiles",
    "faultInjectionFiles",
  ] as const) {
    if (current[key] < baseline[key]) {
      throw new Error(
        `AUTHENTICITY_BASELINE: ${key} ${current[key]} < ${baseline[key]}`
      );
    }
  }
  if (baseline.mockOnlyFiles !== 0 || current.mockOnlyFiles !== 0) {
    throw new Error(
      `MOCK_ONLY: 基线 ${baseline.mockOnlyFiles} / 当前 ${current.mockOnlyFiles} 个无断言的 mock-only 测试文件`
    );
  }
}

export interface SbomComponent {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly kind: "library";
}

export interface Sbom {
  readonly schema: "zeta-sbom-1";
  readonly generatedFrom: string;
  readonly lockfileVersion: number;
  readonly components: readonly SbomComponent[];
}

/** 从 bun.lock 的真实 packages 表生成 SBOM；缺 integrity 的条目视为供应链门失败。 */
function parseLockfile(lockText: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < lockText.length; index += 1) {
    const char = lockText[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && lockText[index + 1] === "/") {
      while (index < lockText.length && lockText[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += char;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"));
}

export function parseSbomFromLockfile(lockText: string, source = "bun.lock"): Sbom {
  let parsed: unknown;
  try {
    parsed = parseLockfile(lockText);
  } catch (error) {
    throw new Error(`SBOM_PARSE: ${source}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("SBOM_SHAPE: 非对象");
  const root = parsed as { lockfileVersion?: unknown; packages?: unknown };
  if (typeof root.lockfileVersion !== "number") throw new Error("SBOM_SHAPE: 缺 lockfileVersion");
  if (typeof root.packages !== "object" || root.packages === null) {
    throw new Error("SBOM_SHAPE: 缺 packages");
  }
  const components: SbomComponent[] = [];
  for (const [name, entry] of Object.entries(root.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error(`SBOM_SPEC_INVALID: ${name}`);
    }
    const spec = entry[0];
    if (spec.includes("@workspace:")) continue;
    if (entry.length < 4 || typeof entry[3] !== "string") {
      throw new Error(`SBOM_INTEGRITY_MISSING: ${name}`);
    }
    const at = spec.lastIndexOf("@");
    if (at <= 0) throw new Error(`SBOM_VERSION_INVALID: ${name}`);
    const componentName = spec.slice(0, at);
    const version = spec.slice(at + 1).split("(")[0]!;
    if (version === "") throw new Error(`SBOM_VERSION_INVALID: ${name}`);
    components.push({ name: componentName, version, integrity: entry[3], kind: "library" });
  }
  const unique = new Map(components.map((item) => [`${item.name}@${item.version}`, item]));
  const sorted = [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  );
  components.length = 0;
  components.push(...sorted);
  return {
    schema: "zeta-sbom-1",
    generatedFrom: source,
    lockfileVersion: root.lockfileVersion,
    components,
  };
}

export interface ReleaseAgeInput {
  readonly name: string;
  readonly version: string;
  readonly publishedAt: string | null;
}

export interface ReleaseAgeResult {
  readonly checked: number;
  readonly skipped: number;
  readonly tooNew: readonly string[];
  readonly minDays: number;
}

/** 发布时间不可得时只计入 skipped，绝不当作已通过。 */
export function checkReleaseAges(
  inputs: readonly ReleaseAgeInput[],
  now: Date,
  minDays: number
): ReleaseAgeResult {
  if (!Number.isFinite(minDays) || minDays < 0) throw new Error("INVALID_RELEASE_AGE_WINDOW");
  const tooNew: string[] = [];
  let checked = 0;
  let skipped = 0;
  const threshold = now.getTime() - minDays * 24 * 60 * 60 * 1000;
  for (const input of inputs) {
    if (input.publishedAt === null) {
      skipped += 1;
      continue;
    }
    const published = Date.parse(input.publishedAt);
    if (!Number.isFinite(published)) {
      skipped += 1;
      continue;
    }
    checked += 1;
    if (published > threshold) tooNew.push(`${input.name}@${input.version}`);
  }
  return { checked, skipped, tooNew, minDays };
}

export interface PerfMetrics {
  readonly firstFrameMs: number;
  readonly effectMs: number;
  readonly reloadMs: number;
  readonly guardWaitMs: number;
  readonly longSessionMs: number;
  readonly memBytes: number;
  readonly tokenCost: number;
}

export interface PerfBudget {
  readonly maxFirstFrameMs: number;
  readonly maxEffectMs: number;
  readonly maxReloadMs: number;
  readonly maxGuardWaitMs: number;
  readonly maxLongSessionMs: number;
  readonly maxMemBytes: number;
  readonly maxTokenCost: number;
}

export interface PerfCheck {
  readonly name: keyof PerfMetrics;
  readonly value: number;
  readonly limit: number;
  readonly ok: boolean;
}

export function evaluatePerf(metrics: PerfMetrics, budget: PerfBudget): readonly PerfCheck[] {
  const names = Object.keys(metrics) as (keyof PerfMetrics)[];
  for (const name of names) {
    if (!Number.isFinite(metrics[name]) || metrics[name] < 0) {
      throw new Error(`PERF_METRIC_INVALID: ${name}`);
    }
  }
  const limits: Record<keyof PerfMetrics, number> = {
    firstFrameMs: budget.maxFirstFrameMs,
    effectMs: budget.maxEffectMs,
    reloadMs: budget.maxReloadMs,
    guardWaitMs: budget.maxGuardWaitMs,
    longSessionMs: budget.maxLongSessionMs,
    memBytes: budget.maxMemBytes,
    tokenCost: budget.maxTokenCost,
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`PERF_BUDGET_INVALID: ${name}`);
    }
  }
  return names.map((name) => ({
    name,
    value: metrics[name],
    limit: limits[name],
    ok: metrics[name] <= limits[name],
  }));
}
