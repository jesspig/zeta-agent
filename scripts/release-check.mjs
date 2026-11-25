/**
 * T-01 发布候选校验 v2：版本、架构、SBOM、迁移/回滚说明与平台冒烟证据。
 *
 * v2 报告绑定 baseline commit、source tree hash、runId、buildCommand、generatedAt
 * 与 worktreeClean；commit 来自 git 实测或 --baseline 显式传入，绝不硬编码。
 * 本机未覆盖的 target 记为 skipped，绝不写成 pass。
 * 运行：bun scripts/release-check.mjs [--baseline=<sha>] [--run-id=<id>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGETS,
  buildPlanFor,
  detectBinaryArch,
  sha256Hex,
  verifyArtifactBytes,
  verifyArtifactManifest,
} from "../packages/deploy/src/index.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_SCHEMA = "zeta-release/2";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function versionFromSource(root = ROOT) {
  const text = readFileSync(join(root, "apps/zeta-cli/src/index.ts"), "utf8");
  const match = /const VERSION = "([^"]+)"/.exec(text);
  return match?.[1];
}

export function hostTargetLocal() {
  const candidate = `${process.platform}-${process.arch}`;
  return (TARGETS).includes(candidate) ? candidate : undefined;
}

export function collectSkippedTargets(reportPath, host) {
  const gates = readJson(reportPath);
  const skipped = [];
  let hostPass = false;
  for (const target of TARGETS) {
    const gate = gates.find((item) => item.id === `platform:${target}`);
    if (gate?.status === "pass" && target === host) hostPass = true;
    else if (gate?.status !== "pass") skipped.push(target);
  }
  return { skipped, hostPass };
}

export function verifySbomShape(reportPath) {
  if (!existsSync(reportPath)) return { ok: false, detail: `SBOM 不存在: ${reportPath}` };
  const sbom = readJson(reportPath);
  const components = Array.isArray(sbom?.components) ? sbom.components : [];
  const bad = components.filter(
    (item) => typeof item.name !== "string" || typeof item.version !== "string" || !/^sha512-/.test(item.integrity ?? "")
  );
  const ok = sbom?.schema === "zeta-sbom-1" && components.length >= 120 && bad.length === 0;
  return {
    ok,
    detail: `schema=${sbom?.schema ?? "unknown"} components=${components.length} 无完整性摘要=${bad.length}`,
  };
}

export function verifyRunbook(path) {
  if (!existsSync(path)) return { ok: false, detail: `runbook 不存在: ${path}` };
  const text = readFileSync(path, "utf8");
  const required = ["## 安装", "## 升级", "## 回滚", "release-check", "smoke-local"];
  const missing = required.filter((needle) => !text.includes(needle));
  return {
    ok: missing.length === 0,
    detail: missing.length === 0 ? "安装/升级/回滚与校验命令齐全" : `缺少: ${missing.join(", ")}`,
  };
}

function checkArtifact(root, host) {
  if (host === undefined) {
    return { id: "artifact", status: "fail", detail: "未知宿主 target，无法定位发布产物", sha256: "" };
  }
  const plan = buildPlanFor(host);
  const dir = join(root, "dist/local", host);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { id: "artifact", status: "fail", detail: `manifest 不存在: ${manifestPath}`, sha256: "" };
  }
  try {
    const manifest = readJson(manifestPath);
    verifyArtifactManifest(manifest);
    if (manifest.target !== host) throw new Error(`TARGET_MISMATCH: ${manifest.target} != ${host}`);
    const binaryPath = join(dir, manifest.binary.path);
    const binary = new Uint8Array(readFileSync(binaryPath));
    const embedded = {};
    for (const item of manifest.embedded) {
      const local = join(dir, item.path);
      // 发布目录只保留目标专属的 arch-marker；通用资源随源码资产保留。
      const asset = existsSync(local) ? local : join(root, "apps/zeta-cli/assets", item.path);
      if (!existsSync(asset)) throw new Error(`EMBEDDED_ASSET_MISSING: ${item.path}`);
      embedded[item.id] = new Uint8Array(readFileSync(asset));
    }
    verifyArtifactBytes(manifest, { binary, ...embedded });
    const detected = detectBinaryArch(binary);
    const sha256 = sha256Hex(binary);
    if (detected !== undefined && detected !== manifest.binary.arch) {
      throw new Error(`BINARY_ARCH_MISMATCH: detected=${detected}`);
    }
    return {
      id: "artifact",
      status: "pass",
      detail: `${host} ${plan.binaryName} sha256=${sha256} arch=${manifest.binary.arch} embedded=${manifest.embedded.length}`,
      sha256,
    };
  } catch (error) {
    return { id: "artifact", status: "fail", detail: String(error), sha256: "" };
  }
}

function checkVersion(root, expected) {
  const host = hostTargetLocal();
  if (host === undefined) return { id: "version", status: "fail", detail: "未知宿主 target" };
  const plan = buildPlanFor(host);
  const binary = join(root, "dist/local", host, plan.binaryName);
  if (!existsSync(binary)) return { id: "version", status: "fail", detail: `发布二进制不存在: ${binary}` };
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", shell: false });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const ok = result.status === 0 && output.includes(`zeta ${expected}`);
  return { id: "version", status: ok ? "pass" : "fail", detail: `exit=${result.status} output=${output}` };
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

export function parseReleaseArgs(argv = []) {
  let baseline;
  let runId;
  for (const arg of argv) {
    if (arg.startsWith("--baseline=")) baseline = arg.slice("--baseline=".length);
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg.startsWith("--")) throw new Error(`UNKNOWN_OPTION: ${arg}`);
  }
  return { baseline, runId };
}

export function collectReleaseBaseline(options = {}) {
  const {
    root = ROOT,
    baselineArg,
    runGit = defaultRunGit(root),
  } = options;
  const commit = (baselineArg ?? runGit(["rev-parse", "HEAD"])).trim();
  if (commit.length === 0) throw new Error("RELEASE_BASELINE_COMMIT_UNAVAILABLE");
  const ref = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "unknown";
  const sourceTreeHash = runGit(["rev-parse", `${commit}^{tree}`]).trim();
  if (sourceTreeHash.length === 0) throw new Error("RELEASE_SOURCE_TREE_HASH_UNAVAILABLE");
  const status = runGit(["status", "--porcelain"]).trim();
  return { ref, commit, sourceTreeHash, worktreeClean: status.length === 0 };
}

export async function buildReport(root = ROOT, options = {}) {
  const {
    baselineArg,
    runIdArg,
    runGit = defaultRunGit(root),
    now = () => new Date(),
    buildCommand = "bun run build",
  } = options;
  const baseline = collectReleaseBaseline({ root, baselineArg, runGit });
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const runId = runIdArg || `zeta-release-${timestamp}-${baseline.commit.slice(0, 8)}`;
  const host = hostTargetLocal();
  const checks = [];

  const version = versionFromSource(root) ?? "unknown";
  checks.push(checkVersion(root, version));

  const artifact = checkArtifact(root, host);
  checks.push({ id: artifact.id, status: artifact.status, detail: artifact.detail });

  const sbom = verifySbomShape(join(root, "reports/sbom.json"));
  checks.push({ id: "sbom", status: sbom.ok ? "pass" : "fail", detail: sbom.detail });

  const runbook = verifyRunbook(join(root, "docs/desgin/delivery/release-runbook.md"));
  checks.push({ id: "migration-rollback", status: runbook.ok ? "pass" : "fail", detail: runbook.detail });

  const platformPath = join(root, "reports/gates-platform.json");
  if (!existsSync(platformPath)) {
    checks.push({ id: "platform-matrix", status: "fail", detail: "gates-platform.json 缺失" });
  } else {
    const { skipped, hostPass } = collectSkippedTargets(platformPath, host);
    checks.push({
      id: "platform-matrix",
      status: hostPass ? "pass" : "fail",
      detail: `宿主 ${host ?? "unknown"} ${hostPass ? "pass" : "未通过"}；非宿主 skipped=${skipped.length}`,
    });
  }

  const unverified = [];
  const agesPath = join(root, "reports/release-ages.json");
  if (existsSync(agesPath)) {
    const ages = readJson(agesPath);
    if ((ages?.result?.tooNew ?? []).length > 0) {
      unverified.push(`release-age: ${ages.result.tooNew.join(", ")}（T-26 已标 unverified，未改阈值）`);
    }
  }

  const skippedTargets = existsSync(platformPath)
    ? collectSkippedTargets(platformPath, host).skipped
    : [...TARGETS];
  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length,
    skipped: skippedTargets.length,
  };
  return {
    schema: RELEASE_SCHEMA,
    generatedAt: now().toISOString(),
    baselineCommit: baseline.commit,
    baselineRef: baseline.ref,
    sourceTreeHash: baseline.sourceTreeHash,
    worktreeClean: baseline.worktreeClean,
    runId,
    buildCommand,
    version,
    hostTarget: host ?? "unknown",
    binarySha256: artifact.sha256,
    checks,
    skippedTargets,
    unverified,
    summary,
  };
}

export function exitCodeForReleaseReport(report) {
  return report.summary.fail === 0 ? 0 : 1;
}

export function renderMarkdown(report) {
  const lines = [
    "# 发布候选校验报告（v2）",
    "",
    `- Schema：\`${report.schema}\``,
    `- 生成时间：${report.generatedAt}`,
    `- Run ID：\`${report.runId}\``,
    `- 基线：${report.baselineRef} @ \`${report.baselineCommit}\``,
    `- 源树哈希：\`${report.sourceTreeHash}\``,
    `- 工作树干净：${report.worktreeClean ? "yes" : "no"}`,
    `- 构建命令：\`${report.buildCommand}\``,
    `- 发布版本：zeta ${report.version}（来源 apps/zeta-cli/src/index.ts 的 VERSION 与二进制 --version 实测）`,
    `- 宿主 target：${report.hostTarget}`,
    `- 二进制 SHA-256：${report.binarySha256 || "未取得"}`,
    "",
    "| 检查项 | 状态 | 明细 |",
    "| --- | --- | --- |",
    ...report.checks.map((item) => `| ${item.id} | ${item.status} | ${item.detail.replace(/\|/g, "\\|")} |`),
    "",
    `汇总：pass=${report.summary.pass} fail=${report.summary.fail} 非宿主 skipped=${report.summary.skipped}`,
    "",
    "## 非宿主 target（skipped，不计 pass）",
    "",
    ...report.skippedTargets.map((target) => `- ${target}: skipped（本机无真实构建产物/无法运行，由 CI 三平台矩阵覆盖）`),
    "",
    "## 待裁决",
    "",
    ...(report.unverified.length > 0 ? report.unverified.map((item) => `- ${item}`) : ["- 无"]),
    "",
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseReleaseArgs(argv);
  const {
    root = ROOT,
    reportDir = join(root, "reports"),
    now = () => new Date(),
    runGit = defaultRunGit(root),
    writeText = (path, text) => writeFileSync(path, text, "utf8"),
    mkdir = (path) => mkdirSync(path, { recursive: true }),
  } = deps;
  const report = await buildReport(root, { baselineArg: args.baseline, runIdArg: args.runId, now, runGit });
  mkdir(reportDir);
  writeText(join(reportDir, "release-candidate.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeText(join(reportDir, "release-candidate.md"), renderMarkdown(report));
  for (const item of report.checks) {
    console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
  }
  console.log(`baseline=${report.baselineCommit} tree=${report.sourceTreeHash} run=${report.runId} clean=${report.worktreeClean}`);
  console.log(`SKIPPED 非宿主 target: ${report.skippedTargets.join(", ")}`);
  console.log(`release-check: pass=${report.summary.pass} fail=${report.summary.fail} skipped=${report.summary.skipped}`);
  return exitCodeForReleaseReport(report);
}

if (import.meta.main) {
  process.exit(await main());
}
