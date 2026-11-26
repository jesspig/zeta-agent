import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORMS = ["windows-latest", "macos-latest", "ubuntu-latest"];

export function verifyCurrentCi(data, commit) {
  if (data?.schema !== 1) throw new Error("CI_SCHEMA_UNSUPPORTED");
  if (data.headSha !== commit) throw new Error(`CI_COMMIT_MISMATCH: expected ${commit}, got ${String(data.headSha)}`);
  if (data.conclusion !== "success") throw new Error(`CI_RUN_NOT_SUCCESS: ${String(data.conclusion)}`);
  for (const platform of PLATFORMS) {
    if (data.quality?.[platform] !== "success") throw new Error(`CI_PLATFORM_NOT_SUCCESS: ${platform}`);
  }
  if (!Number.isInteger(data.releaseMatrix?.total) || data.releaseMatrix.total < 1 ||
      data.releaseMatrix.success !== data.releaseMatrix.total) {
    throw new Error("CI_RELEASE_MATRIX_NOT_SUCCESS");
  }
  return Object.freeze({ commit, platforms: PLATFORMS.length, releaseMatrix: data.releaseMatrix.total });
}

export function main(argv = process.argv.slice(2)) {
  const path = resolve(ROOT, argv[0] ?? "reports/ci-platform.json");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const result = verifyCurrentCi(JSON.parse(readFileSync(path, "utf8")), commit);
  console.log(`PASS current-ci: commit=${result.commit} platforms=${result.platforms} release=${result.releaseMatrix}`);
}

if (import.meta.main) main();
