/**
 * T-24：12 target 的「构建矩阵」与「运行矩阵」分开记录。
 *
 * - 构建矩阵只证明 cross-build/static 产物可复现（manifest + 完整 embedded bytes + SHA-256），
 *   永远不写 native，也不把静态校验写成运行通过。
 * - 运行矩阵区分真实宿主执行（native/pass）与无原生 runner 时的高保真仿真（emulated）。
 *   emulated 只重放与启动相同的真实字节校验路径，不执行目标机器码，状态恒为 emulated，
 *   绝不写成 pass/native；无产物则 skipped。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, verifyArtifactBytes, verifyArtifactManifest, type ArtifactManifest } from "./artifact";
import { buildPlanFor, hostTarget, type LocalBuildPlan } from "./build-plan";
import { computeStableConfigDigest } from "./config-digest";
import { TARGETS, type TargetId } from "./targets";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface LoadedArtifact {
  readonly target: string;
  readonly manifest: ArtifactManifest;
  readonly binary?: Uint8Array;
  readonly embedded: Readonly<Record<string, Uint8Array>>;
}

export interface BuildCheck {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface TargetBuildEvidence {
  readonly target: TargetId;
  readonly kind: "cross-build/static";
  readonly bunTarget: string;
  readonly binaryName: string;
  readonly os: LocalBuildPlan["os"];
  readonly arch: LocalBuildPlan["arch"];
  readonly libc: LocalBuildPlan["libc"];
  readonly baseline: boolean;
  readonly assets: readonly string[];
  readonly status: "pass" | "skipped" | "fail";
  /** 构建矩阵永不声明 native 运行。 */
  readonly native: false;
  readonly artifactVerified: boolean;
  readonly digest: string | null;
  readonly checks: readonly BuildCheck[];
  readonly detail: string;
}

export interface RunCheck {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export type RunMode = "native" | "emulated" | "none";

export interface TargetRunEvidence {
  readonly target: TargetId;
  readonly mode: RunMode;
  readonly native: boolean;
  readonly emulated: boolean;
  readonly status: "pass" | "emulated" | "skipped" | "fail";
  readonly checks: readonly RunCheck[];
  readonly digest: string | null;
  /** native:spawn / emulated:artifact-bytes / none:artifact-missing */
  readonly proof: string;
  readonly detail: string;
}

export interface TargetEvidenceMatrix {
  readonly schema: "zeta-target-evidence/1";
  readonly generatedAt: string;
  readonly host: string;
  readonly build: readonly TargetBuildEvidence[];
  readonly run: readonly TargetRunEvidence[];
  readonly summary: {
    readonly build: { readonly pass: number; readonly skipped: number; readonly fail: number };
    readonly run: { readonly native: number; readonly emulated: number; readonly skipped: number; readonly fail: number };
  };
  readonly honesty: readonly string[];
}

export interface NativeRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly probe: boolean;
}

export interface TargetEvidenceDeps {
  readonly host?: string;
  readonly loadArtifact?: (target: string) => LoadedArtifact | undefined;
  readonly runNative?: (target: string, artifact: LoadedArtifact, plan: LocalBuildPlan) => NativeRunResult;
  /** 无原生产物时的高保真仿真来源；传 false 关闭回退（用于验证 skipped 语义）。 */
  readonly emulationSource?: ((target: string) => LoadedArtifact) | false;
  readonly now?: () => string;
}

const SOURCE_MODE_ASSETS = [
  { id: "arch-marker", path: "arch-marker.zetaasset" },
  { id: "resource-catalog", path: "resource-catalog.zetaasset" },
  { id: "system-prompt", path: "prompts/system.md" },
  { id: "skills-index", path: "skills/builtins/SKILL.md" },
  { id: "config-schema", path: "schema/config.zetaasset" },
] as const;

/**
 * 无目标产物时的仿真来源：仓库内真实源码模式 embedded bytes（非合成 marker）。
 * 只用于仿真启动门禁，不声明为该 target 的真实构建产物或 native 运行。
 */
export function loadSourceModeArtifact(target: string): LoadedArtifact {
  const plan = buildPlanFor(target);
  const assetsRoot = join(repoRoot, "apps/zeta-cli/assets");
  const resources = SOURCE_MODE_ASSETS.map((asset) => {
    const path = join(assetsRoot, asset.path);
    if (!existsSync(path)) throw new Error(`SOURCE_ASSET_MISSING: ${asset.path}`);
    return { id: asset.id, bytes: new Uint8Array(readFileSync(path)) };
  });
  const embedded: Record<string, Uint8Array> = Object.fromEntries(
    resources.map((resource) => [resource.id, resource.bytes])
  );
  const manifest: ArtifactManifest = {
    version: 1,
    target: target as ArtifactManifest["target"],
    binary: { arch: plan.arch, path: plan.binaryName, bytes: 0 },
    embedded: resources.map((resource) => ({
      id: resource.id,
      kind: "data",
      arch: "universal" as const,
      path: SOURCE_MODE_ASSETS.find((asset) => asset.id === resource.id)!.path,
      bytes: resource.bytes.byteLength,
      sha256: sha256Hex(resource.bytes),
    })),
  };
  return { target, manifest, embedded };
}

/** 从 dist/local/<target> 读取真实产物；资源优先取目标目录，其次取源码资产目录。 */
export function loadLocalArtifact(target: string): LoadedArtifact | undefined {
  const plan = buildPlanFor(target);
  const dir = join(repoRoot, "dist/local", target);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  } catch (error) {
    throw new Error(`MANIFEST_INVALID: ${target}: ${(error as Error).message}`);
  }
  const binaryPath = join(dir, plan.binaryName);
  const binary = existsSync(binaryPath) ? new Uint8Array(readFileSync(binaryPath)) : undefined;
  const embedded: Record<string, Uint8Array> = {};
  for (const resource of manifest.embedded) {
    const local = join(dir, resource.path);
    const asset = existsSync(local) ? local : join(repoRoot, "apps/zeta-cli/assets", resource.path);
    if (!existsSync(asset)) throw new Error(`EMBEDDED_ASSET_MISSING: ${resource.path}`);
    embedded[resource.id] = new Uint8Array(readFileSync(asset));
  }
  return { target, manifest, ...(binary === undefined ? {} : { binary }), embedded };
}

/** 宿主 target 的真实可执行启动探针：--version + --capabilities，均为真实子进程。 */
export function runLocalNative(target: string, _artifact: LoadedArtifact, plan: LocalBuildPlan): NativeRunResult {
  const binary = join(repoRoot, "dist/local", target, plan.binaryName);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", shell: false, timeout: 30_000 });
  const capabilities = spawnSync(binary, ["--capabilities"], { encoding: "utf8", shell: false, timeout: 30_000 });
  const stdout = `${version.stdout ?? ""}${capabilities.stdout ?? ""}`;
  const stderr = `${version.stderr ?? ""}${capabilities.stderr ?? ""}`;
  let profile = "";
  try {
    const last = capabilities.stdout?.trim().split(/\r?\n/).at(-1) ?? "";
    profile = String((JSON.parse(last) as { profile?: unknown }).profile ?? "");
  } catch {
    profile = "";
  }
  const probe =
    version.status === 0 &&
    capabilities.status === 0 &&
    version.stdout?.includes("zeta 0.1.0") === true &&
    profile === "local-safe";
  return { code: version.status ?? -1, stdout, stderr, probe };
}

export interface EmulationOptions {
  readonly target?: string;
  readonly binary?: Uint8Array;
}

/**
 * 无原生 runner 组合的高保真仿真：重放真实启动门禁的全部字节校验，
 * 只输出 emulated 状态；不执行目标机器码、不产生任何 native/pass 声明。
 */
export function emulateStartupFromArtifact(
  manifest: ArtifactManifest,
  embedded: Readonly<Record<string, Uint8Array>>,
  options: EmulationOptions = {}
): Omit<TargetRunEvidence, "target"> {
  const checks: RunCheck[] = [];
  let ok = true;
  try {
    verifyArtifactManifest(manifest);
    checks.push({ id: "manifest", status: "pass", detail: `version=${manifest.version} target=${manifest.target}` });
  } catch (error) {
    ok = false;
    checks.push({ id: "manifest", status: "fail", detail: (error as Error).message });
  }
  try {
    verifyArtifactBytes(manifest, { ...(options.binary === undefined ? {} : { binary: options.binary }), ...embedded });
    checks.push({ id: "bytes", status: "pass", detail: `embedded=${manifest.embedded.length}` });
  } catch (error) {
    ok = false;
    checks.push({ id: "bytes", status: "fail", detail: (error as Error).message });
  }
  for (const resource of manifest.embedded) {
    const content = embedded[resource.id];
    checks.push({
      id: `embedded:${resource.id}`,
      status: content !== undefined && content.byteLength === resource.bytes ? "pass" : "fail",
      detail: content === undefined ? "missing" : `bytes=${content.byteLength} sha256=${resource.sha256.slice(0, 12)}`,
    });
    if (content === undefined || content.byteLength !== resource.bytes) ok = false;
  }
  const digest = computeStableConfigDigest({ target: options.target ?? manifest.target, manifest });
  checks.push({ id: "config-digest", status: digest.length > 0 ? "pass" : "fail", detail: digest });
  if (digest.length === 0) ok = false;
  checks.push({
    id: "readiness",
    status: ok ? "pass" : "fail",
    detail: ok ? "SIMULATED_READY_FROM_VERIFIED_BYTES" : "SIMULATED_NOT_READY_FROM_VERIFIED_BYTES",
  });
  return {
    mode: "emulated",
    native: false,
    emulated: true,
    status: ok ? "emulated" : "fail",
    checks,
    digest,
    proof: "emulated:artifact-bytes",
    detail: `${ok ? "仿真启动门禁全部通过" : "仿真启动门禁失败"}；未执行 ${options.target ?? manifest.target} 机器码，非 native`,
  };
}

function countBy<T extends string>(items: readonly { readonly status: T }[], keys: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const item of items) result[item.status] += 1;
  return result;
}

export function collectTargetEvidence(deps: TargetEvidenceDeps = {}): TargetEvidenceMatrix {
  const host = deps.host ?? hostTarget() ?? "unknown";
  const load = deps.loadArtifact ?? loadLocalArtifact;
  const run = deps.runNative ?? runLocalNative;
  const emulationSource = deps.emulationSource === false ? undefined : (deps.emulationSource ?? loadSourceModeArtifact);
  const now = deps.now ?? (() => new Date().toISOString());

  const build: TargetBuildEvidence[] = [];
  const runMatrix: TargetRunEvidence[] = [];

  for (const target of TARGETS) {
    const plan = buildPlanFor(target);
    let artifact: LoadedArtifact | undefined;
    try {
      artifact = load(target);
    } catch (error) {
      artifact = undefined;
      build.push({
        target,
        kind: "cross-build/static",
        bunTarget: plan.bunTarget,
        binaryName: plan.binaryName,
        os: plan.os,
        arch: plan.arch,
        libc: plan.libc,
        baseline: plan.baseline,
        assets: plan.assets,
        status: "fail",
        native: false,
        artifactVerified: false,
        digest: null,
        checks: [{ id: "load", status: "fail", detail: (error as Error).message }],
        detail: `产物读取失败：${(error as Error).message}`,
      });
      runMatrix.push({
        target,
        mode: "none",
        native: false,
        emulated: false,
        status: "fail",
        checks: [{ id: "artifact", status: "fail", detail: (error as Error).message }],
        digest: null,
        proof: "none:artifact-load-failed",
        detail: "产物不可用，未运行也未仿真",
      });
      continue;
    }
    if (artifact === undefined) {
      build.push({
        target,
        kind: "cross-build/static",
        bunTarget: plan.bunTarget,
        binaryName: plan.binaryName,
        os: plan.os,
        arch: plan.arch,
        libc: plan.libc,
        baseline: plan.baseline,
        assets: plan.assets,
        status: "skipped",
        native: false,
        artifactVerified: false,
        digest: null,
        checks: [{ id: "artifact", status: "fail", detail: "dist/local 无该 target 产物" }],
        detail: "本机无该 target 构建产物；由 CI 构建矩阵覆盖，不计 pass",
      });
      if (emulationSource === undefined || target === host) {
        runMatrix.push({
          target,
          mode: "none",
          native: false,
          emulated: false,
          status: "skipped",
          checks: [{ id: "artifact", status: "fail", detail: "dist/local 无该 target 产物" }],
          digest: null,
          proof: "none:artifact-missing",
          detail: "无产物，未运行也未仿真；不计 pass",
        });
        continue;
      }
      let source: LoadedArtifact;
      try {
        source = emulationSource(target);
      } catch (error) {
        runMatrix.push({
          target,
          mode: "none",
          native: false,
          emulated: false,
          status: "skipped",
          checks: [{ id: "emulation-source", status: "fail", detail: (error as Error).message }],
          digest: null,
          proof: "none:emulation-source-missing",
          detail: "仿真来源不可用，未运行；不计 pass",
        });
        continue;
      }
      const emulated = emulateStartupFromArtifact(source.manifest, source.embedded, { target });
      runMatrix.push({
        target,
        ...emulated,
        proof: "emulated:source-asset-bytes",
        detail: `${emulated.detail}；使用仓库源码模式真实 embedded bytes 仿真，非该 target 原生产物，不替代真实产物校验`,
      });
      continue;
    }

    const buildChecks: BuildCheck[] = [];
    let buildOk = true;
    try {
      verifyArtifactManifest(artifact.manifest);
      buildChecks.push({ id: "manifest", status: "pass", detail: `target=${artifact.manifest.target}` });
    } catch (error) {
      buildOk = false;
      buildChecks.push({ id: "manifest", status: "fail", detail: (error as Error).message });
    }
    try {
      verifyArtifactBytes(artifact.manifest, {
        ...(artifact.binary === undefined ? {} : { binary: artifact.binary }),
        ...artifact.embedded,
      });
      buildChecks.push({
        id: "bytes",
        status: "pass",
        detail: `embedded=${artifact.manifest.embedded.length} 全部逐项校验`,
      });
    } catch (error) {
      buildOk = false;
      buildChecks.push({ id: "bytes", status: "fail", detail: (error as Error).message });
    }
    const digest = artifact.manifest.binary.sha256 ?? null;
    build.push({
      target,
      kind: "cross-build/static",
      bunTarget: plan.bunTarget,
      binaryName: plan.binaryName,
      os: plan.os,
      arch: plan.arch,
      libc: plan.libc,
      baseline: plan.baseline,
      assets: plan.assets,
      status: buildOk ? "pass" : "fail",
      native: false,
      artifactVerified: buildOk,
      digest,
      checks: buildChecks,
      detail: buildOk
        ? `cross-build/static 逐项校验通过；SHA-256=${digest?.slice(0, 12) ?? "n/a"}`
        : `cross-build/static 校验失败：${buildChecks.filter((item) => item.status === "fail").map((item) => item.detail).join("；")}`,
    });

    if (target !== host) {
      const emulated = emulateStartupFromArtifact(artifact.manifest, artifact.embedded, {
        target,
        ...(artifact.binary === undefined ? {} : { binary: artifact.binary }),
      });
      runMatrix.push({ target, ...emulated });
      continue;
    }
    const result = run(target, artifact, plan);
    const checks: RunCheck[] = [
      {
        id: "native-spawn",
        status: result.code === 0 ? "pass" : "fail",
        detail: `exit=${result.code}`,
      },
      {
        id: "native-probe",
        status: result.probe ? "pass" : "fail",
        detail: result.probe ? "--version/--capabilities 真实应答" : `${result.stdout.trim().slice(0, 120)} ${result.stderr?.trim().slice(0, 120) ?? ""}`,
      },
    ];
    runMatrix.push({
      target,
      mode: "native",
      native: true,
      emulated: false,
      status: result.code === 0 && result.probe ? "pass" : "fail",
      checks,
      digest,
      proof: "native:spawn",
      detail: `宿主 target 真实二进制启动与探针${result.code === 0 && result.probe ? "通过" : "失败"}`,
    });
  }

  const buildCounts = countBy(build, ["pass", "skipped", "fail"] as const);
  const runCounts = countBy(runMatrix, ["pass", "emulated", "skipped", "fail"] as const);
  return {
    schema: "zeta-target-evidence/1",
    generatedAt: now(),
    host,
    build,
    run: runMatrix,
    summary: {
      build: buildCounts,
      run: {
        native: runCounts.pass,
        emulated: runCounts.emulated,
        skipped: runCounts.skipped,
        fail: runCounts.fail,
      },
    },
    honesty: [
      "构建矩阵（build）只记录 cross-build/static 校验，不声明 native 运行。",
      "运行矩阵（run）中只有宿主 target 为 native/pass；其它 target 为 emulated 或 skipped，永不写 pass/native。",
      "emulated 基于真实产物 embedded bytes 重放启动门禁，不执行目标机器码，属于高保真仿真而非原生运行；无目标产物时改用仓库源码模式真实 embedded bytes 仿真并显式标注，不替代真实产物校验。",
      "skipped 表示本机无产物或未运行，不计入 pass；合成 marker 不允许替代真实 embedded bytes。",
    ],
  };
}
