import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_EVIDENCE_SCHEMA,
  digestString,
  readCiEvidence,
  unverifiedCiEvidence,
  verifyCiEvidence,
} from "./ci-evidence.mjs";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function fixture(root) {
  const bytes = Buffer.from("acceptance evidence fixture\n", "utf8");
  writeFileSync(join(root, "artifact.log"), bytes);
  const digest = digestString(bytes);
  return {
    schema: CI_EVIDENCE_SCHEMA,
    run: { id: 12345, headSha: HEAD, status: "completed", conclusion: "success" },
    requiredJobs: ["build", "test"],
    jobs: [
      { id: "build", conclusion: "success" },
      { id: "test", conclusion: "success" },
    ],
    artifacts: [{ name: "acceptance", digest, path: "artifact.log" }],
    expectedDigests: { acceptance: digest },
  };
}

describe("T-01 CI 证据验真（纯函数，只读本地 JSON）", () => {
  test("完整且一致的本地证据通过", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-ok-"));
    try {
      const result = verifyCiEvidence(fixture(dir), { baselineCommit: HEAD, root: dir });
      expect(result.result).toBe("pass");
      expect(result.reasonCodes).toEqual([]);
      expect(result.runs[0].id).toBe(12345);
      expect(result.runs[0].headSha).toBe(HEAD);
      expect(result.verifier).toBe("ci-evidence/1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("headSha 不等于 baseline commit 时失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-head-"));
    try {
      const data = fixture(dir);
      data.run.headSha = "f".repeat(40);
      const result = verifyCiEvidence(data, { baselineCommit: HEAD, root: dir });
      expect(result.result).toBe("fail");
      expect(result.reasonCodes).toContain("CI_HEAD_SHA_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("required job 非 success 时失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-job-"));
    try {
      const data = fixture(dir);
      data.jobs[1].conclusion = "failure";
      const result = verifyCiEvidence(data, { baselineCommit: HEAD, root: dir });
      expect(result.result).toBe("fail");
      expect(result.reasonCodes).toContain("CI_REQUIRED_JOB_NOT_SUCCESS:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("artifact digest 与声明期望不一致时失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-digest-"));
    try {
      const data = fixture(dir);
      data.expectedDigests.acceptance = digestString(Buffer.from("tampered", "utf8"));
      const result = verifyCiEvidence(data, { baselineCommit: HEAD, root: dir });
      expect(result.result).toBe("fail");
      expect(result.reasonCodes).toContain("CI_ARTIFACT_DIGEST_MISMATCH:acceptance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("本地 artifact 实际字节哈希不匹配时失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-bytes-"));
    try {
      const data = fixture(dir);
      writeFileSync(join(dir, "artifact.log"), "tampered bytes\n");
      const result = verifyCiEvidence(data, { baselineCommit: HEAD, root: dir });
      expect(result.result).toBe("fail");
      expect(result.reasonCodes).toContain("CI_ARTIFACT_FILE_DIGEST_MISMATCH:acceptance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run id 缺失时失败；无文件输入时未核验", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-id-"));
    try {
      const data = fixture(dir);
      delete data.run.id;
      const result = verifyCiEvidence(data, { baselineCommit: HEAD, root: dir });
      expect(result.reasonCodes).toContain("CI_RUN_ID_MISSING");
      expect(unverifiedCiEvidence().result).toBe("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCiEvidence 只读本地文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ci-read-"));
    try {
      const path = join(dir, "ci.json");
      writeFileSync(path, JSON.stringify(fixture(dir)));
      expect(readCiEvidence(path).schema).toBe(CI_EVIDENCE_SCHEMA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
