/**
 * T-01 验收报告 v2（zeta-acceptance/2）。
 *
 * 报告只从本次运行的命令日志与退出码渲染：每项命令的原始输出落盘并记录 sha256，
 * Markdown 由同一份 JSON 生成，禁止合并历史报告或手工改判 pass。
 * 运行：bun scripts/acceptance-report.mjs [Axx ...] [--baseline=<sha>] [--ci-evidence=<path>] [--run-id=<id>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCiEvidence, unverifiedCiEvidence } from "./ci-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_REL = "reports";
const EVIDENCE_REL = "reports/evidence/acceptance";
const BUN = process.execPath;
const SCHEMA = "zeta-acceptance/2";
export const GENERATOR_VERSION = "2.0.0";
export const CRITERION_VERSION = "zeta-criteria/a1-a40/1";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const ITEMS = [
  { id: "A1", title: "build/typecheck/test 全绿、lockfile、依赖图无环", commands: [
    { args: ["run", "check"], expect: "45 successful" },
    { args: ["x", "turbo", "run", "typecheck", "--force"], expect: "15 successful" },
    { args: ["test"], expect: "0 fail" },
  ] },
  { id: "A2", title: "事实登记 P1-P10 指向实现与测试", commands: [
    { args: ["scripts/check-fact-registry.mjs"], expect: "P1-P10 均指向" },
  ] },
  { id: "A3", title: "同配置不同顺序观察等价（Thm 80）", commands: [
    { args: ["test", "packages/testing/src/properties.spec.ts", "packages/components/loader/src/config.spec.ts", "packages/components/loader/src/reconcile.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A4", title: "随机装卸无残留、逆各一次（Cor 69）", commands: [
    { args: ["test", "packages/testing/src/properties.spec.ts", "packages/components/cordis/src/fiber.spec.ts", "packages/components/cordis/src/effect.cleanup.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A5", title: "guard teardown 可读依赖、撤回延迟（Thm 70）", commands: [
    { args: ["test", "packages/framework/src/context.lifecycle.spec.ts", "packages/testing/src/properties.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A6", title: "12 条不变量 legacy/plugin 双版 + 双门", commands: [
    { args: ["test", "packages/agent-framework/src/runtime/invariants.spec.ts", "packages/agent-framework/src/runtime/invariants-naming.spec.ts", "packages/agent-framework/src/tools/invariants.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-invariant-points.mjs"] },
  ] },
  { id: "A7", title: "工具热插拔声明同步；权限热更新不 reload", commands: [
    { args: ["test", "packages/framework/src/loader/plugin-transaction.spec.ts", "packages/agent/src/facade.tool-boundary.spec.ts", "packages/agent/src/plugins/permissions/policy.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A8", title: "工具副作用分类审查与默认发射策略", commands: [
    { args: ["test", "packages/agent/src/tools.spec.ts", "packages/components/security/src/emission.spec.ts", "packages/components/security/src/egress.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A9", title: "testRender 帧快照覆盖消息/工具/状态/overlay/槽位", commands: [
    { args: ["test", "packages/tui/src/runtime.spec.tsx", "packages/tui/src/components/transcript.visual.spec.tsx", "packages/tui/src/approval-ui.spec.tsx", "packages/tui/src/slots.spec.ts", "packages/tui/src/create-tui.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A10", title: "--print/--json/--rpc 无 TTY 可用", commands: [
    { args: ["test", "apps/zeta-cli/src/headless-isolation.spec.ts", "apps/zeta-cli/src/print-e2e.spec.ts", "packages/agent/src/cli/modes.spec.ts", "packages/agent/src/cli/modes.failure.spec.ts", "packages/deploy/src/rpc.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A11", title: "HMR 真实插件替换、失败保留旧 artifact/FAILED 重试", commands: [
    { args: ["test", "packages/agent/src/plugins/hot-reload.e2e.spec.ts", "apps/zeta-cli/src/hot-reload.spec.ts", "packages/components/loader/src/hmr.spec.ts", "packages/agent/src/extensions/hot-reload.e2e.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A12", title: "自修改候选隔离构建/exports/依赖环/能力审查", commands: [
    { args: ["test", "packages/agent/src/extensions/loader.generation.spec.ts", "packages/framework/src/loader/extension-policy.spec.ts", "packages/framework/src/loader/plugin-transaction.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A13", title: "五模式派发与单调 guard", commands: [
    { args: ["test", "packages/components/events/src/events.spec.ts", "packages/agent-framework/src/runtime/agent.spec.ts", "packages/agent-framework/src/tools/pipeline.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A14", title: "配置顺序汇合与 patch 整块替换", commands: [
    { args: ["test", "packages/components/loader/src/config.spec.ts", "packages/deploy/src/canonical.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A15", title: "durable 双崩溃窗口与幂等 adapter", commands: [
    { args: ["test", "packages/agent/src/plugins/effects/durable.crash.spec.ts", "packages/components/security/src/outbox.spec.ts", "packages/components/security/src/emission.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A16", title: "晋升单调性：仅严格更优且资格合格替换", commands: [
    { args: ["test", "packages/agent/src/research/promotion.spec.ts", "packages/agent/src/research/guardrails.spec.ts", "packages/agent/src/research/decision.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A17", title: "重放不变量 budget/order/legal/best", commands: [
    { args: ["test", "packages/agent/src/research/frozen.spec.ts", "packages/agent/src/research/pipeline.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A18", title: "观察等价晋升：typed recap 六段与外置取回", commands: [
    { args: ["test", "packages/agent-framework/src/session/surface.spec.ts", "packages/agent-framework/src/session/recap.spec.ts", "packages/agent/src/facade.compaction.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A19", title: "grader 信息不进改进上下文，tripwire 抛错", commands: [
    { args: ["test", "packages/agent/src/facade.a21a22.spec.ts", "packages/tui/src/osc-security.spec.ts", "packages/components/observability/src/index.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A20", title: "自演化前后 24 条不变量全绿", commands: [
    { args: ["test", "packages/agent/src/research/promotion.spec.ts", "packages/agent-framework/src/runtime/invariants.spec.ts", "packages/agent-framework/src/tools/invariants.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A21", title: "可观测性归因/脱敏/OTLP 降级/汇合不变", commands: [
    { args: ["test", "packages/framework/src/context.tenant.spec.ts", "packages/agent/src/facade.tenant.spec.ts", "packages/agent/src/tenant/governance.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A22", title: "ExecutionBackend 强制、capability 降级 FAILED、凭证不入日志", commands: [
    { args: ["test", "packages/agent/src/tools/backend.contract.spec.ts", "packages/components/security/src/backend.matrix.spec.ts", "packages/components/security/src/credentials.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A23", title: "egress 默认拒绝、进程外审计完整性标记", commands: [
    { args: ["test", "packages/components/security/src/egress.dataplane.spec.ts", "packages/components/security/src/audit.integrity.spec.ts", "packages/components/security/src/audit.socket.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A24", title: "Cordis 官方源码对照（@mode/HMR/两层撤销）", commands: [
    { args: ["test", "packages/components/cordis/src/reflect.spec.ts", "packages/components/cordis/src/fiber.spec.ts", "packages/components/loader/src/hmr.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A25", title: "Effect 4 形态/Impl/6 态/AgentPluginApi 可编译", commands: [
    { args: ["x", "turbo", "run", "typecheck", "--force"], expect: "15 successful" },
  ] },
  { id: "A26", title: "typed recap、workspace:/// 取回、双阈值与 peak", commands: [
    { args: ["test", "packages/agent-framework/src/session/offload.t12.spec.ts", "packages/agent/src/facade.compaction.spec.ts", "packages/agent/src/session/store.conformance.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A27", title: "经验检索与完整 evidence 落盘", commands: [
    { args: ["test", "packages/agent/src/research/experience.spec.ts", "packages/agent/src/research/experience-library.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A28", title: "多租户 realm 隔离与配额 coeffect", commands: [
    { args: ["test", "packages/agent/src/tenant/object-distribution.spec.ts", "packages/agent/src/tenant/object-host.spec.ts", "packages/components/capabilities/src/quota.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A29", title: "fitness seam、A/B、回归门禁与实验隔离", commands: [
    { args: ["test", "packages/agent/src/research/fitness.spec.ts", "packages/deploy/src/fitness.spec.ts", "packages/deploy/src/fitness.budget-identity.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A30", title: "local/daemon/remote 真实拓扑、canonical digest、架构校验、gRPC", commands: [
    { args: ["test", "packages/deploy/src/daemon.spec.ts", "packages/deploy/src/remote.spec.ts", "packages/deploy/src/rpc.spec.ts", "packages/deploy/src/runtime-probes.spec.ts", "packages/deploy/src/artifact.spec.ts", "packages/deploy/src/canonical.spec.ts", "packages/deploy/src/targets.spec.ts", "packages/deploy/src/grpc.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-grpc-wire.mjs"] },
  ], note: "wire-level gRPC 由 proto 桩的真实 unary 往返覆盖" },
  { id: "A31", title: "package graph 无环且跨包相对 import 被拒", commands: [
    { args: ["scripts/check-core-dependencies.mjs"] },
    { args: ["scripts/guard-architecture.mjs"] },
    { args: ["test", "scripts/guard-architecture.spec.mjs"], expect: "0 fail" },
    { args: ["scripts/check-facade-exports.mjs"] },
    { args: ["scripts/check-aggregate-exports.mjs"] },
  ] },
  { id: "A32", title: "公开 API 无未实现 stub / 静默 no-op", commands: [
    { args: ["scripts/check-api-stubs.mjs"], expect: "无未实现标记" },
    { args: ["scripts/check-facade-exports.mjs"] },
    { args: ["test", "packages/agent/src/facade.security-backend.spec.ts", "packages/components/security/src/backend.unconnected.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A33", title: "持久化三类崩溃与未知结果可恢复", commands: [
    { args: ["test", "packages/agent/src/session/jsonl.store.spec.ts", "packages/agent/src/session/sqlite.store.spec.ts", "packages/agent/src/plugins/effects/durable.crash.spec.ts", "packages/components/security/src/outbox.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A34", title: "run/tool/session 并发生命周期完备", commands: [
    { args: ["test", "packages/agent-framework/src/runtime/core.lifecycle.spec.ts", "packages/agent-framework/src/runtime/loop.lifecycle.spec.ts", "packages/agent/src/facade.cancellation.spec.ts", "packages/agent/src/session/tree.atomic.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A35", title: "文件/进程/网络/凭证/审计由真实边界强制", commands: [
    { args: ["test", "packages/agent/src/tools/backend.contract.spec.ts", "packages/components/security/src/egress.dataplane.spec.ts", "packages/components/security/src/vault.ownership.spec.ts", "packages/components/security/src/audit.integrity.spec.ts", "packages/components/security/src/emission.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A36", title: "local/daemon/remote 与三平台 12 target 矩阵", commands: [
    { args: ["scripts/gate-platform.mjs"] },
    { args: ["scripts/smoke-local.ts"], expect: "PASS rollback" },
    { args: ["scripts/release-check.mjs"] },
  ], note: "本机仅 win32-x64 可运行；11 个非宿主 target 为 skipped，不计 pass，待 CI 裁决" },
  { id: "A37", title: "Provider/MCP/RPC/CLI conformance 全绿", commands: [
    { args: ["test", "packages/agent/src/providers/conformance.spec.ts", "packages/agent/src/plugins/mcp/conformance.spec.ts", "packages/deploy/src/rpc.spec.ts", "apps/zeta-cli/src/print-e2e.spec.ts", "apps/zeta-cli/src/args.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A38", title: "性能预算与资源增长回归门", commands: [
    { args: ["scripts/gate-performance.mjs"], expect: "PASS perf-budget" },
    { args: ["test", "packages/deploy/src/budget.spec.ts", "packages/deploy/src/budget.fields.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A39", title: "文档能力矩阵与代码装配自动一致", commands: [
    { args: ["scripts/check-capability-matrix.mjs"], expect: "装配清单一致" },
    { args: ["scripts/check_docs_links.mjs"], expect: "0 断链" },
  ] },
  { id: "A40", title: "研究轨所有晋升路径强制经过四道护栏", commands: [
    { args: ["test", "packages/agent/src/research/guardrails.spec.ts", "packages/agent/src/research/promotion.spec.ts", "packages/agent/src/research/decision.spec.ts", "packages/deploy/src/fitness.budget-identity.spec.ts"], expect: "0 fail" },
  ] },
];

export const ACCEPTANCE_SCHEMA = SCHEMA;
export const ITEM_IDS = ITEMS.map((item) => item.id);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitize(text) {
  const posixRoot = ROOT.replace(/\\/g, "/");
  return text
    .split(BUN).join("bun")
    .split(`file:///${posixRoot}/`).join("./")
    .split(`${posixRoot}/`).join("./")
    .split(ROOT).join(".")
    .replace(/[A-Za-z]:\\(?:[^\\]+\\)*zeta-agent\\/g, "./")
    .replace(/[A-Za-z]:\/(?:[^\/]+\/)*zeta-agent\//g, "./");
}

export function buildSummaryFromLogs(output) {
  const lines = output.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  const matched = (line) => line.length > 0 && /pass|fail|PASS|FAIL|SKIPPED|UNVERIFIED|successful|exit=|SHA-256|装配|断链|没有|无未实现/i.test(line);
  const picked = [];
  for (let index = lines.length - 1; index >= 0 && picked.length < 6; index -= 1) {
    const line = lines[index].trim();
    if (!matched(line)) break;
    picked.unshift(line);
  }
  return picked.join("\n") || "无匹配摘要行（见日志）";
}

export function parseArgs(argv = []) {
  const ids = [];
  let baseline;
  let ciEvidence;
  let runId;
  let acceptedRisks;
  let expectedDigests;
  for (const arg of argv) {
    if (arg.startsWith("--baseline=")) baseline = arg.slice("--baseline=".length);
    else if (arg.startsWith("--ci-evidence=")) ciEvidence = arg.slice("--ci-evidence=".length);
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg.startsWith("--accepted-risks=")) acceptedRisks = arg.slice("--accepted-risks=".length);
    else if (arg.startsWith("--expected-digests=")) expectedDigests = arg.slice("--expected-digests=".length);
    else if (arg.startsWith("--")) throw new Error(`UNKNOWN_OPTION: ${arg}`);
    else ids.push(arg);
  }
  const unknown = ids.filter((id) => !ITEM_IDS.includes(id));
  if (unknown.length > 0) throw new Error(`UNKNOWN_ITEM_ID: ${unknown.join(", ")}`);
  return { ids, baseline, ciEvidence, runId, acceptedRisks, expectedDigests };
}

export function defaultRunGit(root = ROOT) {
  return (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`GIT_FAILED: ${args.join(" ")} (${result.error?.message ?? result.stderr?.trim() ?? result.status})`);
    }
    return result.stdout;
  };
}

export function collectRunContext(options = {}) {
  const {
    root = ROOT,
    baselineArg,
    runIdArg,
    runGit = defaultRunGit(root),
    now = () => new Date(),
    readBytes = (path) => readFileSync(path),
  } = options;
  const commit = (baselineArg ?? runGit(["rev-parse", "HEAD"])).trim();
  if (commit.length === 0) throw new Error("BASELINE_COMMIT_UNAVAILABLE");
  const ref = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "unknown";
  const sourceTreeHash = runGit(["rev-parse", `${commit}^{tree}`]).trim();
  if (sourceTreeHash.length === 0) throw new Error("SOURCE_TREE_HASH_UNAVAILABLE");
  const status = runGit(["status", "--porcelain"]).trim();
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const generatorSourceHash = sha256Hex(readBytes(join(root, "scripts/acceptance-report.mjs")));
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  return {
    id: runIdArg || `zeta-acceptance-${timestamp}-${commit.slice(0, 8)}`,
    baseline: {
      ref,
      commit,
      sourceTreeHash,
      worktreeClean: status.length === 0,
    },
    toolchain: {
      bun: process.versions.bun ?? null,
      node: process.versions.node,
      packageManager: packageJson.packageManager ?? "unknown",
    },
    generator: { version: GENERATOR_VERSION, sourceHash: generatorSourceHash },
    criterionVersion: CRITERION_VERSION,
    generatedAt: now().toISOString(),
  };
}

export function executeCommand(spec, context = {}) {
  const {
    root = ROOT,
    bun = BUN,
    runId,
    itemId,
    index = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawn = spawnSync,
    writeBytes = (path, bytes) => writeFileSync(path, bytes),
  } = context;
  const result = spawn(bun, spec.args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitLine = `exit=${result.status ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}${result.error ? ` error=${result.error.code ?? "unknown"}` : ""}\n`;
  const rendered = sanitize(`${stdout}${stderr}${exitLine}`);
  const logPath = `${EVIDENCE_REL}/${runId}/${itemId}.${index}.log`;
  const bytes = Buffer.from(rendered, "utf8");
  writeBytes(join(root, logPath), bytes);
  const timedOut = result.error?.code === "ETIMEDOUT" || result.timedOut === true;
  return {
    argv: ["bun", ...spec.args],
    cwd: ".",
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    timedOut,
    spawnError: result.error?.message ?? null,
    log: { path: logPath, sha256: sha256Hex(bytes), bytes: bytes.length },
    output: rendered,
    expected: spec.expect === undefined ? true : new RegExp(spec.expect).test(rendered),
  };
}

export function defaultPlatformSkip(root = ROOT) {
  const path = join(root, "reports/gates-platform.json");
  if (!existsSync(path)) return ["gates-platform.json 缺失"];
  const gates = JSON.parse(readFileSync(path, "utf8"));
  const skipped = gates
    .filter((gate) => gate.id?.startsWith("platform:") && gate.status !== "pass")
    .map((gate) => gate.id?.replace("platform:", "") ?? "unknown");
  return skipped;
}

export function evaluateItem(item, commandResults, options = {}) {
  const reasonCodes = [];
  let status = "pass";
  let note = item.note;
  for (const command of commandResults) {
    let commandStatus = "pass";
    if (command.spawnError !== null && command.spawnError !== undefined) {
      commandStatus = "blocked";
      reasonCodes.push(`COMMAND_SPAWN_ERROR:${command.spawnError}`);
    } else if (command.timedOut) {
      commandStatus = "fail";
      reasonCodes.push(`COMMAND_TIMED_OUT:${command.argv.join(" ")}`);
    } else if (command.signal !== null && command.signal !== undefined) {
      commandStatus = "fail";
      reasonCodes.push(`COMMAND_SIGNAL:${command.signal}`);
    } else if (command.exitCode !== 0) {
      commandStatus = "fail";
      reasonCodes.push(`COMMAND_NONZERO_EXIT:${command.argv.join(" ")}=${command.exitCode}`);
    } else if (!command.expected) {
      commandStatus = "fail";
      reasonCodes.push(`EXPECTED_MARKER_MISSING:${command.argv.join(" ")}`);
    }
    if (commandStatus === "fail") status = "fail";
    else if (commandStatus === "blocked" && status !== "fail") status = "blocked";
  }
  if (item.id === "A36") {
    const skipped = options.platformSkipped ?? defaultPlatformSkip(options.root ?? ROOT);
    if (skipped.length > 0) {
      status = "fail";
      reasonCodes.push(`PLATFORM_TARGETS_SKIPPED:${skipped.join(",")}`);
      note = `${item.note ?? ""}；证据：${skipped.join(", ")}`;
    }
  }
  const logs = commandResults.map((command) => command.output).join("\n");
  return {
    id: item.id,
    title: item.title,
    criterionVersion: options.criterionVersion ?? CRITERION_VERSION,
    status,
    commands: commandResults.map((command) => ({
      argv: command.argv,
      cwd: command.cwd,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      log: command.log,
    })),
    evidence: commandResults.map((command) => command.log.path),
    summary: buildSummaryFromLogs(logs),
    reasonCodes,
    note,
  };
}

export async function runAcceptance(ids = [], options = {}) {
  const {
    root = ROOT,
    runId,
    criterionVersion = CRITERION_VERSION,
    execute = executeCommand,
    platformSkipped = defaultPlatformSkip(root),
  } = options;
  mkdirSync(join(root, EVIDENCE_REL), { recursive: true });
  const selected = ids.length === 0 ? ITEMS : ITEMS.filter((item) => ids.includes(item.id));
  if (selected.length === 0) throw new Error(`NO_ITEMS_SELECTED: ${ids.join(", ")}`);
  const results = [];
  for (const item of selected) {
    const commandResults = [];
    for (let index = 0; index < item.commands.length; index += 1) {
      commandResults.push(execute(item.commands[index], { root, runId, itemId: item.id, index }));
    }
    results.push(evaluateItem(item, commandResults, { criterionVersion, platformSkipped, root }));
    console.log(`${results[results.length - 1].status.toUpperCase()} ${item.id}: ${item.title}`);
  }
  return results;
}

function fullPlan(ids, reasonCodes) {
  return {
    mode: "full",
    reusedIds: [],
    rerunIds: ids.length === 0 ? ITEM_IDS.slice() : ITEM_IDS.slice(),
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["PARTIAL_NOT_REQUESTED"],
  };
}

/**
 * 纯函数：只有 baseline/sourceTreeHash/criterionVersion/generatorVersion 完全一致
 * 且旧日志哈希存在并与落盘字节匹配时，才允许复用未请求项；否则全量重跑。
 */
export function planPartialRerun(options = {}) {
  const {
    ids = [],
    previous,
    context,
    root = ROOT,
    readBytes = (path) => readFileSync(join(root, path)),
  } = options;
  if (ids.length === 0) return fullPlan(ids, ["PARTIAL_NOT_REQUESTED"]);
  if (previous === undefined || previous === null || previous.schema !== SCHEMA) {
    return fullPlan(ids, ["PARTIAL_PREVIOUS_SCHEMA_MISMATCH"]);
  }
  const reasons = [];
  const previousContext = previous.run ?? {};
  if (previousContext.baseline?.commit !== context.baseline.commit) reasons.push("PARTIAL_BASELINE_MISMATCH");
  if (previousContext.baseline?.ref !== context.baseline.ref) reasons.push("PARTIAL_BASELINE_REF_MISMATCH");
  if (previousContext.baseline?.sourceTreeHash !== context.baseline.sourceTreeHash) {
    reasons.push("PARTIAL_SOURCE_TREE_HASH_MISMATCH");
  }
  if (previousContext.generator?.version !== context.generator.version
    || previousContext.generator?.sourceHash !== context.generator.sourceHash) {
    reasons.push("PARTIAL_GENERATOR_MISMATCH");
  }
  const previousItems = Array.isArray(previous.items) ? previous.items : [];
  if (previousItems.length !== ITEM_IDS.length) reasons.push("PARTIAL_ITEMS_INCOMPLETE");
  for (const item of previousItems) {
    if (item?.criterionVersion !== context.criterionVersion) {
      reasons.push(`PARTIAL_CRITERION_VERSION_MISMATCH:${item?.id ?? "unknown"}`);
      continue;
    }
    const commands = Array.isArray(item.commands) ? item.commands : [];
    if (commands.length === 0) reasons.push(`PARTIAL_LOG_HASH_MISSING:${item.id}`);
    for (const command of commands) {
      const digest = command?.log?.sha256;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
        reasons.push(`PARTIAL_LOG_HASH_MISSING:${item.id}`);
        continue;
      }
      try {
        if (sha256Hex(readBytes(command.log.path)) !== digest.toLowerCase()) {
          reasons.push(`PARTIAL_LOG_HASH_MISMATCH:${item.id}`);
        }
      } catch {
        reasons.push(`PARTIAL_LOG_HASH_MISSING:${item.id}`);
      }
    }
  }
  if (reasons.length > 0) return fullPlan(ids, [...new Set(reasons)]);
  return {
    mode: "partial",
    reusedIds: ITEM_IDS.filter((id) => !ids.includes(id)),
    rerunIds: ITEM_IDS.filter((id) => ids.includes(id)),
    reasonCodes: [],
  };
}

export function applyAcceptedRisks(items, risks = []) {
  if (!Array.isArray(risks)) throw new TypeError("acceptedRisks 必须是数组");
  return items.map((item) => {
    const matched = risks.filter((risk) => risk?.itemId === item.id || risk?.itemId === "*");
    if (matched.length === 0) return item;
    return {
      ...item,
      reasonCodes: [...new Set([...(item.reasonCodes ?? []), "ACCEPTED_RISK_RECORDED"])],
    };
  });
}

export function assertAcceptedRisksDoNotUpgrade(before, after) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  for (const item of after) {
    const prior = beforeById.get(item.id);
    if (prior !== undefined && prior.status !== "pass" && item.status === "pass") {
      throw new Error(`ACCEPTED_RISK_UPGRADED_PASS: ${item.id}`);
    }
  }
}

export function exitCodeForReport(report) {
  const badItem = report.items.some((item) => item.status !== "pass");
  return badItem || report.ciEvidence?.result === "fail" ? 1 : 0;
}

export function renderAcceptanceMarkdown(report) {
  const items = report.items ?? [];
  const count = (status) => items.filter((item) => item.status === status).length;
  const pass = count("pass");
  const fail = count("fail");
  const blocked = count("blocked");
  const unverified = count("unverified");
  const lines = [
    "# A1–A40 最终验收报告（v2）",
    "",
    `- Schema：\`${report.schema}\``,
    `- Run ID：\`${report.run.id}\``,
    `- 基线：${report.run.baseline.ref} @ \`${report.run.baseline.commit}\``,
    `- 源树哈希：\`${report.run.baseline.sourceTreeHash}\``,
    `- 工作树干净：${report.run.baseline.worktreeClean ? "yes" : "no"}`,
    `- 工具链：bun=${report.run.toolchain.bun ?? "unknown"} node=${report.run.toolchain.node} packageManager=${report.run.toolchain.packageManager}`,
    `- 生成器：${report.run.generator.version} @ \`${report.run.generator.sourceHash}\``,
    `- CI 证据：${report.ciEvidence.result}（${report.ciEvidence.verifier}）${report.ciEvidence.reasonCodes.length > 0 ? `；${report.ciEvidence.reasonCodes.join(", ")}` : ""}`,
    `- 部分重跑：${report.partialRerun.mode}；复用=${report.partialRerun.reusedIds.length}；重跑=${report.partialRerun.rerunIds.length}${report.partialRerun.reasonCodes.length > 0 ? `；${report.partialRerun.reasonCodes.join(", ")}` : ""}`,
    `- 结论：pass=${pass} fail=${fail} blocked=${blocked} unverified=${unverified} 共=${items.length}`,
    "- 口径：摘要片段逐项取自本次运行的命令日志，原始字节见 evidence 路径与 SHA-256；未通过项不写 pass。",
    "",
    "| ID | 判据版本 | 结论 | 关键证据（本次日志摘要） | 原因码 |",
    "| --- | --- | --- | --- | --- |",
    ...items.map((item) => {
      const detail = `${item.evidence.join("、")}；${item.summary.replace(/\n/g, "<br>")}`;
      return `| ${item.id} | ${item.criterionVersion} | ${item.status.toUpperCase()} | ${detail.replace(/\|/g, "\\|")} | ${item.reasonCodes.join(", ")} |`;
    }),
    "",
    "## 待裁决项",
    "",
    "- A36：本机仅 win32-x64 可安装/启动/升级/回滚，其余非宿主 target 不计 pass；需 CI 三平台矩阵补证。",
    "- 供应链与 CI 证据未通过项保持 fail/unverified，不作为 A 项 pass 依据。",
    "",
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const {
    root = ROOT,
    reportDir = join(root, REPORT_REL),
    runGit = defaultRunGit(root),
    now = () => new Date(),
    execute = executeCommand,
    runAcceptanceFn = runAcceptance,
    readText = (path) => readFileSync(path, "utf8"),
    writeText = (path, text) => writeFileSync(path, text, "utf8"),
    mkdir = (path) => mkdirSync(path, { recursive: true }),
  } = deps;
  const context = deps.context ?? collectRunContext({ root, baselineArg: args.baseline, runIdArg: args.runId, runGit, now });
  const previousPath = join(reportDir, "acceptance-report.json");
  const previous = existsSync(previousPath) ? JSON.parse(readText(previousPath)) : undefined;
  const plan = deps.plan ?? planPartialRerun({ ids: args.ids, previous, context, root });

  const targets = plan.mode === "partial" ? plan.rerunIds : ITEM_IDS;
  const fresh = await runAcceptanceFn(targets, {
    root,
    runId: context.id,
    criterionVersion: context.criterionVersion,
    execute,
  });
  const freshById = new Map(fresh.map((item) => [item.id, item]));
  let items = (previous?.items ?? []).map((item) => freshById.get(item.id) ?? item);
  for (const item of fresh) {
    if (!items.some((existing) => existing.id === item.id)) items.push(item);
  }
  items = ITEMS.map((item) => items.find((candidate) => candidate.id === item.id)).filter((item) => item !== undefined);

  let ciEvidence = unverifiedCiEvidence();
  if (args.ciEvidence !== undefined) {
    const ciPath = isAbsolute(args.ciEvidence) ? args.ciEvidence : resolve(root, args.ciEvidence);
    const data = JSON.parse(readText(ciPath));
    const expectedDigests = args.expectedDigests !== undefined
      ? JSON.parse(readText(isAbsolute(args.expectedDigests) ? args.expectedDigests : resolve(root, args.expectedDigests)))
      : data.expectedDigests ?? {};
    ciEvidence = verifyCiEvidence(data, { baselineCommit: context.baseline.commit, root, expectedDigests });
  }

  let acceptedRisks = [];
  if (args.acceptedRisks !== undefined) {
    const riskPath = isAbsolute(args.acceptedRisks) ? args.acceptedRisks : resolve(root, args.acceptedRisks);
    acceptedRisks = JSON.parse(readText(riskPath));
  }
  const beforeRisks = items;
  items = applyAcceptedRisks(items, acceptedRisks);
  assertAcceptedRisksDoNotUpgrade(beforeRisks, items);

  const report = {
    schema: SCHEMA,
    run: context,
    items,
    ciEvidence,
    partialRerun: plan,
    acceptedRisks,
  };
  mkdir(reportDir);
  writeText(join(reportDir, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeText(join(reportDir, "acceptance-report.md"), renderAcceptanceMarkdown(report));
  const code = exitCodeForReport(report);
  console.log(`acceptance v2: run=${context.id} baseline=${context.baseline.commit} ci=${ciEvidence.result} exit=${code}`);
  return code;
}

if (import.meta.main) {
  process.exit(await main());
}
