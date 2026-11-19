import { describe, expect, test } from "bun:test";
import { testRender } from "./frame";

describe("T-27 testRender frame snapshots", () => {
  const state = {
    width: 20,
    height: 5,
    lines: ["hello", "world"],
    hud: "CTX 1/2 50%",
  };

  test("frame snapshot is stable and contains all visible content", () => {
    const frame = testRender(state);

    expect(frame).toBe(testRender(state));
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
    expect(frame).toContain("CTX 1/2 50%");
  });

  test("frame rows are fixed-width and height-bounded", () => {
    const rows = testRender(state).split("\n");

    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toHaveLength(20);
  });

  test("invalid dimensions are rejected", () => {
    expect(() => testRender({ ...state, width: 1 })).toThrow();
    expect(() => testRender({ ...state, height: 1 })).toThrow();
  });
});
