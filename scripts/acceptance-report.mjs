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
export const GENERATOR_VERSION = "2.1.0";
export const CRITERION_VERSION = "zeta-criteria/ac01-ac25/1";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const ITEMS = [
  { id: "AC-01", title: "验收/发布报告绑定 commit、runId、日志哈希，fail 非零退出", commands: [
    { args: ["test", "scripts/acceptance-report.spec.mjs", "scripts/ci-evidence.spec.mjs", "scripts/release-check.spec.mjs", "scripts/check-current-ci.spec.mjs"], expect: "0 fail" },
  ] },
  { id: "AC-02", title: "RED 反例先失败，文档基线与研究映射无断链", commands: [
    { args: ["scripts/red-gates.mjs"], expect: "0 RED" },
    { args: ["scripts/check_docs_links.mjs"], expect: "0 断链" },
  ] },
  { id: "AC-03", title: "Fiber 父 update 旧子退役与有界状态机", commands: [
    { args: ["test", "packages/components/cordis/src", "packages/framework/src/context.lifecycle.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-04", title: "Context/coeffect/events/exports 契约一致", commands: [
    { args: ["test", "packages/components/cordis/src", "packages/components/events/src", "packages/components/loader/src"], expect: "0 fail" },
  ] },
  { id: "AC-05", title: "loader/HMR 连通提交、registry.replace 与故障回退", commands: [
    { args: ["test", "packages/components/loader/src", "packages/framework/src/loader"], expect: "0 fail" },
  ] },
  { id: "AC-06", title: "loop decision/natural/all-terminate 队列语义", commands: [
    { args: ["test", "packages/agent-framework/src/runtime"], expect: "0 fail" },
  ] },
  { id: "AC-07", title: "生产 hook 单一 manager 与 priority/order/no-throw", commands: [
    { args: ["test", "packages/agent-framework/src/plugins", "packages/agent/src/facade.tool-boundary.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-08", title: "模型工具与 runTool 同管线、schema 与 idle settle", commands: [
    { args: ["test", "packages/agent-framework/src/tools", "packages/agent/src/facade.pipeline.t08.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-09", title: "SessionStore 重开 transcript/system/tool 与 usage", commands: [
    { args: ["test", "packages/agent/src/facade.session-restore.t09.spec.ts", "packages/agent/src/session"], expect: "0 fail" },
  ] },
  { id: "AC-10", title: "HMR 真实插件更新与 shutdown 无悬挂", commands: [
    { args: ["test", "packages/agent/src/plugins", "packages/agent/src/extensions", "apps/zeta-cli/src/hot-reload.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-11", title: "每跳 egress/凭证重验与跨 origin 去凭证", commands: [
    { args: ["test", "packages/components/security/src/egress.dataplane.spec.ts", "packages/components/security/src/credentials.spec.ts", "packages/agent/src/providers"], expect: "0 fail" },
  ] },
  { id: "AC-12", title: "文件原子写、结构化 shell、超时取消底层执行", commands: [
    { args: ["test", "packages/agent/src/tools", "packages/components/security/src/backend.matrix.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-13", title: "不可信插件真实 VM/进程求值与逃逸测试", commands: [
    { args: ["test", "packages/agent-framework/src/plugins/isolated-evaluator.spec.ts", "packages/agent/src/facade.isolated-plugin.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-14", title: "journal 原子、receipt、unknown 对账与 audit ack", commands: [
    { args: ["test", "packages/agent/src/plugins/effects", "packages/components/security/src/audit.integrity.spec.ts", "packages/components/security/src/audit.socket.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-15", title: "双租户实例/事件/配额/effects 隔离与 origin 门禁", commands: [
    { args: ["test", "packages/agent/src/tenant"], expect: "0 fail" },
  ] },
  { id: "AC-16", title: "daemon TTL/503/非 loopback 明文拒绝", commands: [
    { args: ["test", "packages/deploy/src/daemon.spec.ts", "packages/deploy/src/remote.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-17", title: "JSONL/SQLite 重开续聊、fork 与三崩溃窗口", commands: [
    { args: ["test", "packages/agent/src/session", "packages/agent/src/facade.session-restore.t17.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-18", title: "recap 请求投影、峰值下降与 RPC 持久控制", commands: [
    { args: ["test", "packages/agent/src/facade.compaction.projection.spec.ts", "packages/agent/src/assembly/protocol.session-control.spec.ts", "packages/deploy/src/rpc.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-19", title: "MCP schema、三 transport 与 OAuth/unsupported", commands: [
    { args: ["test", "packages/agent/src/plugins/mcp"], expect: "0 fail" },
  ] },
  { id: "AC-20", title: "六 profile 真实可运行与单文件断网内置资源", commands: [
    { args: ["test", "packages/agent/src/assembly/profile-conformance.spec.ts", "packages/agent/src/resources"], expect: "0 fail" },
    { args: ["scripts/build-local.ts"] },
    { args: ["scripts/smoke-local.ts"], expect: "PASS" },
  ] },
  { id: "AC-21", title: "晋升授权不可转移、24 不变量与失败重放拒绝", commands: [
    { args: ["test", "packages/agent/src/research/promotion.spec.ts", "packages/agent/src/research/pipeline.spec.ts", "packages/agent/src/research/guardrails.spec.ts"], expect: "0 fail" },
  ] },
  { id: "AC-22", title: "证据库不可变、effect span/OTLP 与两轮研究闭环", commands: [
    { args: ["test", "packages/agent/src/research", "packages/components/observability/src"], expect: "0 fail" },
  ] },
  { id: "AC-23", title: "三平台真实 PTY 无 skip 与 CLI/RPC 全方法", commands: [
    { args: ["scripts/gate-pty.mjs"], expect: "PASS pty:host" },
    { args: ["test", "apps/zeta-cli/src", "packages/deploy/src/rpc.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-current-ci.mjs"], expect: "PASS current-ci" },
  ] },
  { id: "AC-24", title: "12 target 运行证据、embedded bytes 与升级回滚", commands: [
    { args: ["run", "build:local"] },
    { args: ["scripts/guard-architecture.mjs"], expect: "架构守护通过" },
    { args: ["scripts/target-evidence.mjs"], expect: "PASS" },
    { args: ["scripts/smoke-local.ts"], expect: "PASS rollback" },
    { args: ["test", "packages/deploy/src/lifecycle.staged.spec.ts", "packages/deploy/src/supervisor.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-current-ci.mjs"], expect: "PASS current-ci" },
  ] },
  { id: "AC-25", title: "全量 check/gates/acceptance v2 与 RC 绑定最终 commit", commands: [
    { args: ["run", "check"], expect: "45 successful" },
    { args: ["scripts/release-check.mjs"], expect: "fail=0" },
  ], note: "acceptance v2 整体退出码由本报告证明；RC 必须绑定本次 baseline commit" },
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
  mkdirSync(dirname(join(root, logPath)), { recursive: true });
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
