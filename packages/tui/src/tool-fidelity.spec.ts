import { describe, expect, test } from "bun:test";
import {
  formatPreview,
  renderShell,
  resolveMedia,
  STATUS_BACKGROUND,
  statusOfResult,
} from "./components/tool-box";

describe("T-06 工具渲染增强", () => {
  test("三态背景色映射：pending/success/error 各自独立且为合法色值", () => {
    expect(STATUS_BACKGROUND.pending).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(STATUS_BACKGROUND.success).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(STATUS_BACKGROUND.error).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(new Set(Object.values(STATUS_BACKGROUND)).size).toBe(3);
  });

  test("statusOfResult：isError 映射 error，否则 success", () => {
    expect(statusOfResult({ isError: true })).toBe("error");
    expect(statusOfResult({ isError: false })).toBe("success");
  });

  test("formatPreview：<=10 行全显；>10 行折叠为 N more lines 提示", () => {
    const short = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
    expect(formatPreview(short, false)).toBe(short);
    expect(formatPreview(short, false)).not.toContain("more lines");

    const long = Array.from({ length: 15 }, (_, i) => `L${i}`).join("\n");
    const folded = formatPreview(long, false);
    expect(folded).toContain("… (5 more lines, Ctrl+O to expand)");
    expect(folded).not.toContain("L14");

    const expanded = formatPreview(long, true);
    expect(expanded).toBe(long);
    expect(expanded).toContain("L14");
  });

  test("renderShell 扩展点：注入 shell 值格式化为 $ 前缀命令", () => {
    expect(renderShell({ command: "ls -la", exitCode: 0 })).toContain("$ ls -la");
    expect(renderShell({ command: "false", exitCode: 1 })).toContain("exit 1");
    expect(renderShell(null)).toBe("");
  });

  test("图片渲染/text 降级：无图片数据时不抛错，返回文本降级占位", () => {
    const fallback = resolveMedia(undefined);
    expect(fallback.kind).toBe("text");
    expect(fallback.kind === "text" && fallback.text).toContain("[image");
    const withData = resolveMedia({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(withData.kind).toBe("image");
  });
});
