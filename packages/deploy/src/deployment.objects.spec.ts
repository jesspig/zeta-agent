import { describe, expect, test } from "bun:test";
import { computeConfigDigest } from "./deployment";

/** 补审 CR-S04：配置摘要必须区分 Date/Map/Set 的不同值。 */
describe("T-45 配置摘要对象编码", () => {
  test("不同 Date 值产生不同摘要", () => {
    const a = computeConfigDigest({ at: new Date("2026-01-01") });
    const b = computeConfigDigest({ at: new Date("2026-06-01") });
    expect(a).not.toBe(b);
  });

  test("不同 Map/Set 内容产生不同摘要", () => {
    expect(computeConfigDigest({ m: new Map([["k", 1]]) })).not.toBe(computeConfigDigest({ m: new Map([["k", 2]]) }));
    expect(computeConfigDigest({ s: new Set([1]) })).not.toBe(computeConfigDigest({ s: new Set([2]) }));
  });

  test("循环引用不抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof computeConfigDigest({ c: cyclic })).toBe("string");
  });
});
