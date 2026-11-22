import { describe, expect, test } from "bun:test";
import { observeState, sameObservation } from "./observation";

/** CR-40：观测器必须反映 Map/Set 的内容，不能把它们当空对象。 */
describe("T-40 测试观测器容器语义", () => {
  test("不同内容的 Map 判定为不同观测", () => {
    const a = new Map([["k", 1]]);
    const b = new Map([["k", 2]]);
    expect(observeState(a)).not.toBe(observeState(b));
    expect(sameObservation(a, b)).toBe(false);
  });

  test("不同内容的 Set 判定为不同观测", () => {
    expect(sameObservation(new Set([1]), new Set([2]))).toBe(false);
  });

  test("相同内容的 Map 判定为相同观测", () => {
    expect(sameObservation(new Map([["k", 1]]), new Map([["k", 1]]))).toBe(true);
  });
});
