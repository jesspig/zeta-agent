import { describe, expect, test } from "bun:test";
import {
  createTokenVerifier,
  createTokenVerifierFromHash,
  hashControlToken,
  type TokenVerifierDeps,
} from "./token";

describe("T-16 daemon token 哈希与常数时间比较", () => {
  test("仅保存 SHA-256 摘要，摘要不含明文 token", () => {
    const verifier = createTokenVerifier("super-secret-token");
    expect(verifier.hash).toBe(hashControlToken("super-secret-token"));
    expect(verifier.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier.hash).not.toContain("super-secret-token");
    expect(() => createTokenVerifierFromHash("not-a-digest")).toThrow("DAEMON_TOKEN_HASH_INVALID");
  });

  test("正确 token 放行；错误 token、错误长度与非字符串一律拒绝", () => {
    const verifier = createTokenVerifier("alpha-token");
    expect(verifier.verify("alpha-token")).toBe(true);
    expect(verifier.verify("beta-token!!")).toBe(false);
    expect(verifier.verify("a")).toBe(false);
    expect(verifier.verify(null)).toBe(false);
    expect(verifier.verify(42)).toBe(false);
  });

  test("所有候选都走注入的常数时间比较，且比较双方均为 32 字节哈希", () => {
    const calls: Array<{ left: number; right: number }> = [];
    const deps: TokenVerifierDeps = {
      equal(left, right) {
        calls.push({ left: left.byteLength, right: right.byteLength });
        // 用与 token 内容无关的返回值，证明结果完全依赖比较器。
        return left.byteLength === 17;
      },
    };
    const verifier = createTokenVerifier("constant-time-token", deps);
    expect(verifier.verify("constant-time-token")).toBe(false);
    expect(verifier.verify("wrong-token")).toBe(false);
    expect(verifier.verify(undefined)).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.left === 32 && call.right === 32)).toBe(true);

    const permissive = createTokenVerifier("constant-time-token", { equal: () => true });
    expect(permissive.verify("constant-time-token")).toBe(true);
  });
});
