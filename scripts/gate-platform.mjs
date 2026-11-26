import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPlanFor,
  detectBinaryArch,
  hostTarget,
  sha256Hex,
  TARGETS,
  verifyArtifactBytes,
  verifyArtifactManifest,
} from "../packages/deploy/src/index.ts";
import { makeGate, readConfig, root, run, writeGates } from "./gate-lib.mjs";

const config = readConfig();
const gates = [];
const host = hostTarget();

const configured = config.supplyChain.targets;
const sameTargets =
  configured.length === TARGETS.length && TARGETS.every((target, index) => configured[index] === target);
gates.push(
  makeGate({
    id: "platform:target-matrix",
    category: "platform",
    name: "12 target 发布矩阵与 deploy TARGETS 一致",
    status: sameTargets ? "pass" : "fail",
    detail: `配置 ${configured.length} 个 / deploy ${TARGETS.length} 个；${configured.join(", ")}`,
    evidence: [{ kind: "config", ref: "quality-gates.config.json" }],
  })
);

const workflowPath = config.supplyChain.requiredCiWorkflow;
const workflow = existsSync(join(root, workflowPath)) ? readFileSync(join(root, workflowPath), "utf8") : "";
const workflowOk =
  workflow.includes(config.supplyChain.ciPlatforms[0]) &&
  workflow.includes(config.supplyChain.ciPlatforms[1]) &&
  workflow.includes(config.supplyChain.ciPlatforms[2]) &&
  config.supplyChain.targets.every((target) => workflow.includes(target));
gates.push(
  makeGate({
    id: "platform:ci-matrix-config",
    category: "platform",
    name: "三平台 CI 工作流覆盖 12 target",
    status: workflowOk ? "pass" : "fail",
    detail: workflowOk
      ? `${workflowPath} 含 3 平台与 12 target；CI 未在本机执行`
      : `${workflowPath} 缺失或未覆盖全部平台/target`,
    evidence: [{ kind: "file", ref: workflowPath }],
  })
);

for (const target of config.supplyChain.targets) {
  const plan = buildPlanFor(target);
  const dir = join(root, "dist/local", target);
  const manifestPath = join(dir, "manifest.json");
  const binaryPath = join(dir, plan.binaryName);
  if (!existsSync(manifestPath) || !existsSync(binaryPath)) {
    gates.push(
      makeGate({
        id: `platform:${target}`,
        category: "platform",
        name: `发布目标 ${target}`,
        status: "skipped",
        scope: "cross-platform",
        detail: "本机无该 target 的真实构建产物，未构建也未运行；由 CI 三平台矩阵覆盖，不计为 pass",
        evidence: [{ kind: "file", ref: `dist/local/${target}/manifest.json` }],
      })
    );
    continue;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyArtifactManifest(manifest);
    if (manifest.target !== target) throw new Error(`MANIFEST_TARGET_MISMATCH: ${manifest.target}`);
    const bytes = new Uint8Array(readFileSync(binaryPath));
    const embedded = {};
    for (const resource of manifest.embedded) {
      const local = join(dir, resource.path);
      const asset = existsSync(local) ? local : join(root, "apps/zeta-cli/assets", resource.path);
      if (!existsSync(asset)) throw new Error(`EMBEDDED_ASSET_MISSING: ${resource.path}`);
      embedded[resource.id] = new Uint8Array(readFileSync(asset));
    }
    verifyArtifactBytes(manifest, { binary: bytes, ...embedded });
    const detected = detectBinaryArch(bytes.subarray(0, 128));
    const isHost = host === target;
    let execution = "本机未执行（非宿主 target）";
    if (isHost) {
      const probe = run(binaryPath, ["--version"]);
      if (probe.code !== 0 || !probe.stdout.includes("zeta 0.1.0")) {
        throw new Error(`HOST_SMOKE_FAILED: ${probe.code} ${probe.out.slice(0, 200)}`);
      }
      execution = "本机真实启动通过";
    }
    gates.push(
      makeGate({
        id: `platform:${target}`,
        category: "platform",
        name: `发布目标 ${target}`,
        status: isHost ? "pass" : "skipped",
        scope: isHost ? "local" : "cross-platform",
        detail: `manifest/digest/架构校验通过（${manifest.binary.sha256.slice(0, 12)}…，检测 ${detected ?? "未知"}）；${execution}`,
        evidence: [
          { kind: "file", ref: `dist/local/${target}/manifest.json` },
          { kind: "measurement", ref: `sha256=${sha256Hex(bytes)}` },
        ],
      })
    );
  } catch (error) {
    gates.push(
      makeGate({
        id: `platform:${target}`,
        category: "platform",
        name: `发布目标 ${target}`,
        status: "fail",
        detail: error.message,
        evidence: [{ kind: "file", ref: `dist/local/${target}/manifest.json` }],
      })
    );
  }
}

if (host !== undefined && existsSync(join(root, "dist/local", host, "manifest.json"))) {
  const smoke = run("bun", ["scripts/smoke-local.ts"]);
  gates.push(
    makeGate({
      id: "platform:host-lifecycle",
      category: "platform",
      name: "宿主 target install/upgrade/rollback 冒烟",
      status: smoke.code === 0 ? "pass" : "fail",
      detail: `${smoke.stdout.trim().split("\n").filter(Boolean).slice(-4).join(" | ")}（exit=${smoke.code}）`,
      exitCode: smoke.code,
      evidence: [{ kind: "command", ref: "bun scripts/smoke-local.ts" }],
    })
  );
} else {
  gates.push(
    makeGate({
      id: "platform:host-lifecycle",
      category: "platform",
      name: "宿主 target install/upgrade/rollback 冒烟",
      status: "skipped",
      scope: "cross-platform",
      detail: "宿主 target 产物缺失，未在本机运行；CI 矩阵覆盖",
    })
  );
}

// T-24：构建矩阵与运行矩阵分列；emulated/skipped 不计为 pass。
const evidencePath = join(root, "reports/target-evidence.json");
if (!existsSync(evidencePath)) {
  gates.push(
    makeGate({
      id: "platform:evidence-matrix",
      category: "platform",
      name: "12 target 构建/运行矩阵分列报告",
      status: "skipped",
      scope: "cross-platform",
      detail: "reports/target-evidence.json 缺失；请先运行 bun scripts/target-evidence.mjs",
      evidence: [{ kind: "file", ref: "reports/target-evidence.json" }],
    })
  );
} else {
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(evidencePath, "utf8"));
    const buildOk =
      matrix.build?.length === 12 &&
      matrix.run?.length === 12 &&
      matrix.build.every((item) => item.kind === "cross-build/static" && item.native === false) &&
      matrix.summary?.build?.fail === 0 &&
      matrix.run.every((item) => {
        if (item.mode === "native") return item.native === true && item.status === "pass";
        if (item.mode === "emulated") return item.native === false && item.emulated === true && item.status !== "pass";
        return item.native === false && item.status !== "pass";
      });
    gates.push(
      makeGate({
        id: "platform:evidence-matrix",
        category: "platform",
        name: "12 target 构建/运行矩阵分列报告",
        status: buildOk ? "pass" : "fail",
        detail: `build pass=${matrix.summary.build.pass}/skipped=${matrix.summary.build.skipped}/fail=${matrix.summary.build.fail}；run native=${matrix.summary.run.native}/emulated=${matrix.summary.run.emulated}/skipped=${matrix.summary.run.skipped}/fail=${matrix.summary.run.fail}；emulated 与 skipped 均不计 pass`,
        evidence: [{ kind: "file", ref: "reports/target-evidence.json" }],
      })
    );
  } catch (error) {
    gates.push(
      makeGate({
        id: "platform:evidence-matrix",
        category: "platform",
        name: "12 target 构建/运行矩阵分列报告",
        status: "fail",
        detail: `矩阵报告不可解析：${error.message}`,
      })
    );
  }
}

writeGates("platform", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
