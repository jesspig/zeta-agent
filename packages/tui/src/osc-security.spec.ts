import { describe, expect, test } from "bun:test";
import { createOscReporter, oscHyperlink } from "./osc";

describe("OSC 8 安全边界", () => {
  test("仅允许 http/https，并编码 params", () => {
    expect(oscHyperlink("https://example.com/a b", { id: "a:b" })).toBe(
      "\x1b]8;;id=a%3Ab:https://example.com/a%20b\x1b\\",
    );
  });

  test("拒绝控制字符、非法 scheme 与相对 URL", () => {
    for (const uri of [
      "https://example.com/\x1b]0;title",
      "https://example.com/\x07",
      "https://example.com/\u009b",
      "javascript:alert(1)",
      "file:///tmp/test",
      "/relative/path",
    ]) {
      expect(() => oscHyperlink(uri)).toThrow("INVALID_OSC_URI");
    }
  });

  test("拒绝非法 params key 与控制字符", () => {
    expect(() => oscHyperlink("https://example.com", { "bad:key": "x" })).toThrow("INVALID_OSC_PARAMS");
    expect(() => oscHyperlink("https://example.com", { id: "x\x1b\\" })).toThrow("INVALID_OSC_PARAMS");
  });

  test("reporter 丢弃非法链接且不写 stdout", () => {
    const written: string[] = [];
    const errors: unknown[] = [];
    const reporter = createOscReporter((sequence) => written.push(sequence), (error) => errors.push(error));
    reporter.link("https://example.com/\x1b]0;title");
    expect(written).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
