import { describe, expect, test } from "bun:test";
import { resultToText } from "./tool-view";

/** 补审 CR-S06：不可序列化的工具结果必须降级为可读字符串，不抛错。 */
describe("T-47 工具结果序列化健壮性", () => {
  test("BigInt 结果返回占位字符串而非抛错", () => {
    expect(() => resultToText({ value: BigInt(1) })).not.toThrow();
    expect(typeof resultToText({ value: BigInt(1) })).toBe("string");
  });

  test("普通对象结果仍返回 JSON", () => {
    expect(resultToText({ foo: "bar" })).toContain("foo");
  });
});
