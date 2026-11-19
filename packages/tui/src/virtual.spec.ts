import { describe, expect, test } from "bun:test";
import { clampScroll, visibleWindow } from "./virtual";

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
