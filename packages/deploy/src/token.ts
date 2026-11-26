import { createHash, timingSafeEqual } from "node:crypto";

export const TOKEN_DIGEST_HEX_LENGTH = 64;

export interface TokenVerifierDeps {
  /** 可注入的常数时间比较实现，用于直接断言 daemon 不会使用 `===` 比较 token。 */
  readonly equal?: (left: Uint8Array, right: Uint8Array) => boolean;
}

export interface TokenVerifier {
  /** SHA-256 十六进制摘要，不保存明文 token。 */
  readonly hash: string;
  /** 对候选 token 走哈希 + 常数时间比较；任意输入（含非字符串）都走同一比较路径。 */
  verify(candidate: unknown): boolean;
}

export function hashControlToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function defaultEqual(left: Uint8Array, right: Uint8Array): boolean {
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createTokenVerifierFromHash(hash: string, deps: TokenVerifierDeps = {}): TokenVerifier {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("DAEMON_TOKEN_HASH_INVALID");
  const expected = Buffer.from(hash, "hex");
  const equal = deps.equal ?? defaultEqual;
  return {
    hash,
    verify(candidate) {
      // 非字符串候选也哈希固定哨兵并执行同样的比较，避免长度/类型分支泄漏时序。
      const digest = hashControlToken(typeof candidate === "string" ? candidate : "\u0000invalid-candidate");
      const matched = equal(Buffer.from(digest, "hex"), expected);
      return typeof candidate === "string" && matched;
    },
  };
}

export function createTokenVerifier(token: string, deps: TokenVerifierDeps = {}): TokenVerifier {
  if (typeof token !== "string" || token.length === 0) throw new Error("DAEMON_TOKEN_REQUIRED");
  return createTokenVerifierFromHash(hashControlToken(token), deps);
}
