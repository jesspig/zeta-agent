import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPlanFor,
  currentRelease,
  hostTarget,
  installRelease,
  rollbackRelease,
  sha256Hex,
  upgradeRelease,
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

  const upgraded = upgradeRelease(installRoot, "1.1.0", manifest, store);
  startOnce(placeBinary(upgraded.to));
  console.log(`PASS upgrade ${upgraded.from} -> ${upgraded.to} digest=${upgraded.digest.slice(0, 12)} start=ok`);

  const rolled = rollbackRelease(installRoot, store);
  startOnce(placeBinary(rolled.to));
  const current = currentRelease(installRoot, store);
  if (current.version !== "1.0.0") throw new Error(`ROLLBACK_VERSION_MISMATCH: ${current.version}`);
  console.log(`PASS rollback ${rolled.from} -> ${rolled.to} digest=${current.digest.slice(0, 12)} start=ok`);
  console.log("smoke-local: 安装/升级/rollback 均通过真实单文件启动");
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
