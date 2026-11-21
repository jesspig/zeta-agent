import { describe, expect, test } from "bun:test";
import {
  formatPasteBlock,
  foldLargePaste,
  oscCopySelection,
  oscHyperlink,
  oscPromptMark,
  parseKittyModifiers,
} from "./osc";

describe("T-07 终端协议", () => {
  test("OSC 133：消息边界 prompt 标记（A=prompt 开始，B=prompt 结束）", () => {
    expect(oscPromptMark("A")).toBe("\x1b]133;A\x1b\\");
    expect(oscPromptMark("B")).toBe("\x1b]133;B\x1b\\");
  });

  test("OSC 52：选择即复制（base64 编码）", () => {
    const seq = oscCopySelection("hello");
    expect(seq).toContain("\x1b]52;c;");
    expect(seq).toContain(Buffer.from("hello").toString("base64"));
    expect(seq).toContain("\x1b\\");
  });

  test("OSC 8：超链接（带 URI 与可选参数）", () => {
    expect(oscHyperlink("https://example.com")).toBe("\x1b]8;;https://example.com\x1b\\");
    const withParams = oscHyperlink("https://example.com", { id: "link1" });
    expect(withParams).toContain("id=link1");
    expect(withParams).toContain("https://example.com");
  });

  test("Kitty 修饰键解析：mode 值 → ctrl/shift/meta/option/super", () => {
    expect(parseKittyModifiers(0)).toEqual({ ctrl: false, shift: false, meta: false, option: false, super: false });
    const ctrl = parseKittyModifiers(4);
    expect(ctrl.ctrl).toBe(true);
    expect(ctrl.shift).toBe(false);
    const shiftMeta = parseKittyModifiers(1 | 2);
    expect(shiftMeta.shift).toBe(true);
    expect(shiftMeta.meta).toBe(true);
    const all = parseKittyModifiers(1 | 2 | 4 | 8 | 16);
    expect(all.super).toBe(true);
    expect(all.option).toBe(true);
  });

  test("paste >10 行折叠为 [paste #N +X lines]，<=10 行原样", () => {
    const short = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(foldLargePaste(short, 1)).toBe(short);

    const long = Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n");
    const folded = foldLargePaste(long, 3);
    expect(folded).toBe("[paste #3 +5 lines]");
    expect(formatPasteBlock(3, 5)).toBe("[paste #3 +5 lines]");
  });
});
