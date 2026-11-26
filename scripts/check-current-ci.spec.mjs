import { describe, expect, test } from "bun:test";
import { verifyCurrentCi } from "./check-current-ci.mjs";

const commit = "a".repeat(40);
function evidence(overrides = {}) {
  return {
    schema: 1,
    runId: 1,
    headSha: commit,
    conclusion: "success",
    quality: { "windows-latest": "success", "macos-latest": "success", "ubuntu-latest": "success" },
    releaseMatrix: { success: 36, total: 36 },
    ...overrides,
  };
}

describe("T-25 current CI evidence", () => {
  test("同一 commit 的三平台与 release 矩阵成功才通过", () => {
    expect(verifyCurrentCi(evidence(), commit)).toEqual({ commit, platforms: 3, releaseMatrix: 36 });
  });

  test("旧 commit、平台失败与矩阵不完整均失败", () => {
    expect(() => verifyCurrentCi(evidence({ headSha: "b".repeat(40) }), commit)).toThrow(/CI_COMMIT_MISMATCH/);
    expect(() => verifyCurrentCi(evidence({ quality: { "windows-latest": "success", "macos-latest": "failure", "ubuntu-latest": "success" } }), commit))
      .toThrow(/CI_PLATFORM_NOT_SUCCESS/);
    expect(() => verifyCurrentCi(evidence({ releaseMatrix: { success: 35, total: 36 } }), commit))
      .toThrow(/CI_RELEASE_MATRIX_NOT_SUCCESS/);
  });
});
