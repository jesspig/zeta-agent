import { describe, expect, test } from "bun:test";
import { canonicalConfigEncoding, computeConfigDigest } from "./canonical";

describe("T-20 canonical config encoding + SHA-256", () => {
  test("摘要为 64 位小写 SHA-256 十六进制", () => {
    const digest = computeConfigDigest({ target: "linux-x64" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("键顺序无关，值变更敏感", () => {
    expect(computeConfigDigest({ a: 1, b: 2 })).toBe(computeConfigDigest({ b: 2, a: 1 }));
    expect(computeConfigDigest({ a: 1 })).not.toBe(computeConfigDigest({ a: 2 }));
  });

  test("Date / Map / Set 的不同值产生不同摘要，且编码互不混淆", () => {
    expect(computeConfigDigest({ at: new Date("2026-01-01T00:00:00.000Z") })).not.toBe(
      computeConfigDigest({ at: new Date("2026-06-01T00:00:00.000Z") })
    );
    expect(computeConfigDigest({ at: "2026-01-01T00:00:00.000Z" })).not.toBe(
      computeConfigDigest({ at: new Date("2026-01-01T00:00:00.000Z") })
    );
    expect(computeConfigDigest({ m: new Map([["k", 1]]) })).not.toBe(
      computeConfigDigest({ m: new Map([["k", 2]]) })
    );
    expect(computeConfigDigest({ s: new Set([1]) })).not.toBe(computeConfigDigest({ s: new Set([2]) }));
    expect(computeConfigDigest({ m: new Map([["k", "v"]]) })).not.toBe(
      computeConfigDigest({ s: new Set(["k"]) })
    );
  });

  test("Map 先按 key 再按 value 排序，插入顺序不影响摘要", () => {
    const a = new Map<unknown, unknown>([
      ["b", 2],
      ["a", 1],
    ]);
    const b = new Map<unknown, unknown>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(computeConfigDigest({ m: a })).toBe(computeConfigDigest({ m: b }));
  });

  test("undefined 与缺键、null 与 undefined 不混淆", () => {
    expect(computeConfigDigest({ a: undefined })).not.toBe(computeConfigDigest({}));
    expect(computeConfigDigest({ a: undefined })).not.toBe(computeConfigDigest({ a: null }));
  });

  test("数字边界不混淆：-0 / 0 / NaN / Infinity / 字符串", () => {
    expect(computeConfigDigest({ n: 0 })).not.toBe(computeConfigDigest({ n: -0 }));
    expect(computeConfigDigest({ n: Number.NaN })).not.toBe(computeConfigDigest({ n: "NaN" }));
    expect(computeConfigDigest({ n: Number.POSITIVE_INFINITY })).not.toBe(
      computeConfigDigest({ n: Number.NEGATIVE_INFINITY })
    );
  });

  test("非法 Date 与 epoch 0 不同，bigint 与同值数字不同", () => {
    expect(computeConfigDigest({ at: new Date(Number.NaN) })).not.toBe(computeConfigDigest({ at: new Date(0) }));
    expect(computeConfigDigest({ n: 1n })).not.toBe(computeConfigDigest({ n: 1 }));
  });

  test("循环引用稳定 terminates，且引用位置影响摘要", () => {
    const first: Record<string, unknown> = {};
    first.self = first;
    const second: Record<string, unknown> = {};
    second.self = second;
    expect(computeConfigDigest({ c: first })).toBe(computeConfigDigest({ c: second }));
    const nested: Record<string, unknown> = { child: {} };
    (nested.child as Record<string, unknown>).back = nested;
    expect(typeof computeConfigDigest({ c: nested })).toBe("string");
    expect(computeConfigDigest({ c: first })).not.toBe(computeConfigDigest({ c: nested }));
  });

  test("共享引用与复制对象编码不同，编码文本包含显式类型标签", () => {
    const shared = { v: 1 };
    const encoding = canonicalConfigEncoding({ a: shared, b: shared });
    expect(encoding).toContain("O#");
    expect(encoding).toContain("R#");
    expect(encoding).not.toBe(canonicalConfigEncoding({ a: { v: 1 }, b: { v: 1 } }));
  });
});
