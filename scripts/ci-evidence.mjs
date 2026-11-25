/**
 * T-01 CI 证据验真：只读本地导出的 GitHub Actions JSON，不访问网络。
 *
 * 校验项：run id、headSha 等于 baseline commit、run/job conclusion、
 * required jobs 全部 success、artifact digest 与声明值/本地文件实际字节一致。
 * 导出纯函数 verifyCiEvidence 供单测使用；I/O 集中在 readCiEvidence。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CI_EVIDENCE_SCHEMA = "zeta-ci-evidence/1";
export const CI_VERIFIER = "ci-evidence/1";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestString(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function parseDigest(value) {
  if (typeof value !== "string") return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim());
  return match?.[1].toLowerCase();
}

/**
 * 纯函数：校验本地 CI JSON 数据。
 * options: { baselineCommit, expectedDigests, root, readBytes }
 */
export function verifyCiEvidence(data, options = {}) {
  const { baselineCommit, expectedDigests = data?.expectedDigests ?? {}, root = process.cwd(), readBytes } = options;
  const reasonCodes = [];
  const checks = [];
  const runs = [];

  const schema = data?.schema;
  if (schema !== CI_EVIDENCE_SCHEMA) reasonCodes.push("CI_SCHEMA_MISMATCH");

  const run = data?.run ?? {};
  const runId = run.id;
  if (runId === undefined || runId === null || runId === "") {
    reasonCodes.push("CI_RUN_ID_MISSING");
  }
  if (typeof baselineCommit !== "string" || baselineCommit.length === 0) {
    reasonCodes.push("CI_BASELINE_COMMIT_MISSING");
  } else if (typeof run.headSha !== "string" || run.headSha.toLowerCase() !== baselineCommit.toLowerCase()) {
    reasonCodes.push("CI_HEAD_SHA_MISMATCH");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    reasonCodes.push("CI_RUN_CONCLUSION_NOT_SUCCESS");
  }

  const requiredJobs = Array.isArray(data?.requiredJobs) ? data.requiredJobs : [];
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  if (requiredJobs.length === 0) reasonCodes.push("CI_REQUIRED_JOBS_MISSING");
  for (const id of requiredJobs) {
    const job = jobs.find((item) => item?.id === id || item?.name === id);
    if (job === undefined) {
      reasonCodes.push(`CI_REQUIRED_JOB_MISSING:${id}`);
    } else if (job.conclusion !== "success") {
      reasonCodes.push(`CI_REQUIRED_JOB_NOT_SUCCESS:${id}`);
    }
  }

  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  if (artifacts.length === 0) reasonCodes.push("CI_ARTIFACTS_MISSING");
  for (const artifact of artifacts) {
    const name = artifact?.name ?? "unknown";
    const declared = parseDigest(artifact?.digest);
    if (declared === undefined) {
      reasonCodes.push(`CI_ARTIFACT_DIGEST_INVALID:${name}`);
      continue;
    }
    const expected = expectedDigests[name];
    if (expected !== undefined && parseDigest(expected) !== declared) {
      reasonCodes.push(`CI_ARTIFACT_DIGEST_MISMATCH:${name}`);
    }
    if (typeof artifact.path === "string" && artifact.path.length > 0) {
      const fullPath = isAbsolute(artifact.path) ? artifact.path : join(root, artifact.path);
      try {
        const bytes = readBytes === undefined ? readFileSync(fullPath) : readBytes(fullPath);
        const actual = sha256Hex(bytes);
        if (actual !== declared) {
          reasonCodes.push(`CI_ARTIFACT_FILE_DIGEST_MISMATCH:${name}`);
        } else {
          checks.push({ name: `artifact:${name}`, ok: true, detail: `sha256=${actual}` });
        }
      } catch {
        reasonCodes.push(`CI_ARTIFACT_FILE_MISSING:${name}`);
      }
    } else if (expected === undefined) {
      reasonCodes.push(`CI_ARTIFACT_DIGEST_UNVERIFIED:${name}`);
    } else {
      checks.push({ name: `artifact:${name}`, ok: true, detail: `sha256=${declared}` });
    }
  }

  runs.push({
    id: runId ?? null,
    headSha: run.headSha ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    requiredJobs: requiredJobs.slice(),
    jobs: jobs.map((job) => ({
      id: job?.id ?? job?.name ?? "unknown",
      conclusion: job?.conclusion ?? null,
    })),
    artifacts: artifacts.map((artifact) => ({
      name: artifact?.name ?? "unknown",
      digest: artifact?.digest ?? null,
      path: artifact?.path ?? null,
    })),
  });

  return {
    verifier: CI_VERIFIER,
    result: reasonCodes.length === 0 ? "pass" : "fail",
    reasonCodes,
    checks,
    runs,
  };
}

export function readCiEvidence(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyCiEvidenceFile(path, options = {}) {
  return verifyCiEvidence(readCiEvidence(path), options);
}

export function unverifiedCiEvidence(reasonCode = "CI_EVIDENCE_NOT_PROVIDED") {
  return {
    verifier: CI_VERIFIER,
    result: "unverified",
    reasonCodes: [reasonCode],
    checks: [],
    runs: [],
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
  if (path === undefined) {
    console.error("usage: bun scripts/ci-evidence.mjs <path> [--baseline=<sha>]");
    process.exit(2);
  }
  const result = verifyCiEvidenceFile(path, { baselineCommit: baseline, root: process.cwd() });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.result === "pass" ? 0 : 1);
}
