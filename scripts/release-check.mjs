/**
 * T-27 发布候选校验：版本、架构、SBOM、迁移/回滚说明与平台冒烟证据。
 *
 * 只读取真实产物与已落盘报告；本机未覆盖的 target 记为 skipped，绝不写成 pass。
 * 运行：bun scripts/release-check.mjs
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

export async function buildReport(root = ROOT) {
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
    generatedAt: new Date().toISOString(),
    version,
    hostTarget: host ?? "unknown",
    binarySha256: artifact.sha256,
    checks,
    skippedTargets,
    unverified,
    summary,
  };
}

export function renderMarkdown(report) {
  const lines = [
    "# 发布候选校验报告",
    "",
    `- 生成时间：${report.generatedAt}`,
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

export async function main() {
  const report = await buildReport();
  const dir = join(ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "release-candidate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "release-candidate.md"), renderMarkdown(report), "utf8");
  for (const item of report.checks) {
    console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
  }
  console.log(`SKIPPED 非宿主 target: ${report.skippedTargets.join(", ")}`);
  console.log(`release-check: pass=${report.summary.pass} fail=${report.summary.fail} skipped=${report.summary.skipped}`);
  return report.summary.fail === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
