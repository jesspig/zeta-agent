import { describe, expect, test } from "bun:test";
import {
  captureScrollAnchor,
  clampScroll,
  createVariableLayout,
  isAtBottom,
  restoreScrollFromAnchor,
  visibleRange,
  visibleWindow,
} from "./virtual";

describe("T-27 virtual scroll window", () => {
  test("visible window covers the viewport and clamps at the end", () => {
    expect(visibleWindow(100, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(100, 10, 5)).toEqual({ start: 5, end: 15 });
    expect(visibleWindow(100, 10, 95)).toEqual({ start: 95, end: 100 });
  });

  test("visible window handles empty, short and negative-scroll boundaries", () => {
    expect(visibleWindow(0, 10, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(5, 10, 3)).toEqual({ start: 3, end: 5 });
    expect(visibleWindow(100, 10, -5)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(10, 0, 5)).toEqual({ start: 5, end: 5 });
  });

  test("clampScroll keeps the offset inside legal bounds", () => {
    expect(clampScroll(100, 10, 95)).toBe(90);
    expect(clampScroll(100, 10, -3)).toBe(0);
    expect(clampScroll(5, 10, 2)).toBe(0);
  });

  test("invalid inputs are rejected", () => {
    expect(() => visibleWindow(-1, 10, 0)).toThrow();
    expect(() => visibleWindow(10, -1, 0)).toThrow();
    expect(() => visibleWindow(10, 10, Number.NaN)).toThrow();
    expect(() => clampScroll(10, 10, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("T-23 variable-height virtual layout", () => {
  const heights = [1, 3, 2, 5, 1, 4, 2, 3];
  const keys = heights.map((_, index) => `row-${index}`);
  const layout = () => createVariableLayout(heights.length, (index) => heights[index] ?? 1);

  test("prefix offsets and lookup stay exact for variable row heights", () => {
    const value = layout();
    expect(value.totalHeight).toBe(21);
    expect(value.offsetOf(0)).toBe(0);
    expect(value.offsetOf(3)).toBe(6);
    expect(value.offsetOf(7)).toBe(18);
    expect(value.indexOfOffset(0)).toBe(0);
    expect(value.indexOfOffset(5)).toBe(2);
    expect(value.indexOfOffset(6)).toBe(3);
    expect(value.indexOfOffset(20)).toBe(7);
    expect(value.indexOfOffset(21)).toBe(8);
  });

  test("visible range covers the scroll window with overscan and clamps at the end", () => {
    const value = layout();
    expect(visibleRange(value, 0, 4)).toEqual({
      start: 0, end: 3, offsetStart: 0, offsetEnd: 6, totalHeight: 21,
    });
    expect(visibleRange(value, 5, 4, 1)).toEqual({
      start: 1, end: 5, offsetStart: 1, offsetEnd: 12, totalHeight: 21,
    });
    expect(visibleRange(value, 100, 4).end).toBe(8);
  });

  test("scroll anchor keeps the same row at the same viewport position across prepends", () => {
    const before = layout();
    const anchor = captureScrollAnchor(before, keys, 7);
    expect(anchor).toEqual({ key: "row-3", offsetWithin: 1 });
    const grownHeights = [2, 2, ...heights];
    const grownKeys = ["new-a", "new-b", ...keys];
    const grown = createVariableLayout(grownHeights.length, (index) => grownHeights[index] ?? 1);
    const restored = restoreScrollFromAnchor(grown, grownKeys, anchor!, 4);
    expect(restored).toBe(before.offsetOf(3) + 4 + 1);
  });

  test("unknown anchor keys fall back to the supplied scroll offset", () => {
    const value = layout();
    const anchor = { key: "deleted-row", offsetWithin: 3 };
    expect(restoreScrollFromAnchor(value, keys, anchor, 4, 9)).toBe(9);
  });

  test("bottom follow is computed from layout height, not entry count", () => {
    const value = layout();
    expect(isAtBottom(value, 17, 4)).toBe(true);
    expect(isAtBottom(value, 16, 4)).toBe(false);
  });

  test("ten-thousand-row lookup is logarithmic and frame budget is bounded", () => {
    const total = 10_000;
    const heightsOf = (index: number): number => 1 + (index % 7);
    const large = createVariableLayout(total, heightsOf);
    const started = performance.now();
    let touched = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const range = visibleRange(large, i * 31, 24, 2);
      touched += range.end - range.start;
      expect(range.end - range.start).toBeLessThanOrEqual(31);
    }
    const elapsed = performance.now() - started;
    expect(touched).toBeLessThan(1_000 * 31);
    expect(elapsed).toBeLessThan(500);
    expect(large.totalHeight).toBe(39_994);
  });

  test("invalid variable heights are rejected", () => {
    expect(() => createVariableLayout(2, (i) => (i === 1 ? 0 : 1))).toThrow();
    expect(() => createVariableLayout(2, () => Number.NaN)).toThrow();
    expect(() => createVariableLayout(-1, () => 1)).toThrow();
  });
});
