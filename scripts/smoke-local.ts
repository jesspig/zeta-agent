import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPlanFor,
  currentRelease,
  hostTarget,
  installRelease,
  readReleaseLog,
  rollbackRelease,
  sha256Hex,
  stageRelease,
  verifyArtifactManifest,
  type ArtifactManifest,
  type ReleaseStore,
} from "../packages/deploy/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = hostTarget();
if (host === undefined) throw new Error("HOST_TARGET_UNKNOWN");
const plan = buildPlanFor(host);
const artifactDir = join(root, "dist/local", host);
const manifestPath = join(artifactDir, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`ARTIFACT_MISSING: ${manifestPath}，请先运行 bun scripts/build-local.ts`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
verifyArtifactManifest(manifest);
if (manifest.binary.sha256 === undefined) throw new Error("ARTIFACT_SHA256_MISSING");

const binary = join(artifactDir, plan.binaryName);
const binaryBytes = readFileSync(binary);
if (sha256Hex(new Uint8Array(binaryBytes)) !== manifest.binary.sha256) throw new Error("ARTIFACT_SHA256_MISMATCH: binary");

const installRoot = mkdtempSync(join(tmpdir(), "zeta-smoke-"));
// lifecycle 传入的路径已经带 installRoot 前缀，这里只做落盘，不重复拼接。
const store: ReleaseStore = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, "utf8");
  },
  exists: (path) => existsSync(path),
  rename: (from, to) => renameSync(from, to),
};

function placeBinary(version: string): string {
  const dir = join(installRoot, "releases", version);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, plan.binaryName);
  copyFileSync(binary, target);
  return target;
}

function startOnce(path: string): void {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`START_FAILED: ${path}: ${result.stderr?.trim() ?? ""}`);
  if (!result.stdout.includes("zeta 0.1.0")) throw new Error(`START_OUTPUT_UNEXPECTED: ${result.stdout.trim()}`);
}

try {
  const installed = installRelease(installRoot, "1.0.0", manifest, store);
  startOnce(placeBinary(installed.version));
  console.log(`PASS install ${installed.version} digest=${installed.digest.slice(0, 12)} start=ok`);

  // T-24：升级走 staged release，先做 digest/config/启动/readiness 校验再原子切换 current。
  const stagedBinary = placeBinary("1.1.0");
  const stagedLogs: unknown[] = [];
  const upgraded = await stageRelease(installRoot, "1.1.0", manifest, store, {
    probe: {
      startup: () => {
        startOnce(stagedBinary);
        return true;
      },
      readiness: () => true,
    },
    log: (event) => stagedLogs.push(event),
  });
  if (upgraded.rolledBack) throw new Error(`STAGED_UPGRADE_ROLLED_BACK: ${upgraded.error ?? ""}`);
  startOnce(placeBinary(upgraded.to));
  if (!readReleaseLog(store, installRoot).some((event) => event.action === "switch")) {
    throw new Error("STAGED_SWITCH_LOG_MISSING");
  }
  console.log(`PASS staged-upgrade ${upgraded.from} -> ${upgraded.to} digest=${upgraded.digest.slice(0, 12)} start=ok log=${stagedLogs.length}`);

  const rolled = rollbackRelease(installRoot, store);
  startOnce(placeBinary(rolled.to));
  const current = currentRelease(installRoot, store);
  if (current.version !== "1.0.0") throw new Error(`ROLLBACK_VERSION_MISMATCH: ${current.version}`);
  if (!readReleaseLog(store, installRoot).some((event) => event.action === "rollback")) {
    throw new Error("ROLLBACK_LOG_MISSING");
  }
  console.log(`PASS rollback ${rolled.from} -> ${rolled.to} digest=${current.digest.slice(0, 12)} start=ok`);
  console.log("smoke-local: 安装 / staged 升级 / rollback 均通过真实单文件启动且日志可复核");

  // T-20 RC：空目录 + 断网（无连接配置，走 echo）+ 重启续聊，全部用真实二进制。
  const offlineDir = mkdtempSync(join(tmpdir(), "zeta-rc-offline-"));
  const env = { ...process.env };
  for (const key of ["ZETA_BASE_URL", "ZETA_API_KEY", "ZETA_MODEL"]) delete env[key];
  env.ZETA_SESSION_PATH = join(offlineDir, "session.jsonl");
  env.ZETA_WORKSPACE_PATH = join(offlineDir, "workspace");
  const runOffline = (args: readonly string[]): string => {
    const result = spawnSync(binary, [...args], {
      cwd: offlineDir,
      env,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error(`RC_START_FAILED: ${args.join(" ")}: ${result.stderr?.trim() ?? ""}`);
    }
    return result.stdout;
  };

  try {
    const first = runOffline(["--headless", "SMOKE_PING"]);
    if (!first.includes("[echo] SMOKE_PING")) {
      throw new Error(`RC_OFFLINE_FIRST_OUTPUT_UNEXPECTED: ${first.trim()}`);
    }
    console.log("PASS rc-offline-first: 空目录断网启动 + echo 真实应答");

    const capabilities = runOffline(["--capabilities"]);
    const report = JSON.parse(capabilities.trim().split(/\r?\n/).at(-1) ?? "") as {
      profile: string;
      resources?: readonly { id: string }[];
      sessionState?: { persisted: boolean; messageCount: number };
    };
    if (report.profile !== "local-safe" || report.sessionState?.persisted !== true) {
      throw new Error(`RC_SESSION_NOT_PERSISTED: ${capabilities.trim()}`);
    }
    if ((report.sessionState?.messageCount ?? 0) < 2) {
      throw new Error(`RC_SESSION_NOT_RESTORED: messageCount=${report.sessionState?.messageCount}`);
    }
    const embeddedIds = (report.resources ?? []).map((item) => item.id);
    for (const id of ["agent:prompt:prompts/system.md", "agent:skill:skills/builtins/SKILL.md", "agent:schema:schema/config.zetaasset"]) {
      if (!embeddedIds.includes(id)) throw new Error(`RC_EMBEDDED_RESOURCE_MISSING: ${id}`);
    }
    console.log(
      `PASS rc-restart-resume: 重启恢复 ${report.sessionState?.messageCount} 条消息，嵌入资源 ${embeddedIds.length} 条`
    );

    const resumed = runOffline(["--headless", "SMOKE_RESUME"]);
    if (!resumed.includes("[echo] SMOKE_RESUME")) {
      throw new Error(`RC_RESUME_OUTPUT_UNEXPECTED: ${resumed.trim()}`);
    }
    console.log("PASS rc-offline-resume: 恢复后继续真实应答");
  } finally {
    rmSync(offlineDir, { recursive: true, force: true });
  }
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
