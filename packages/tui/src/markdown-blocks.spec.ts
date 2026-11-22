import { describe, expect, test } from "bun:test";
import { markdownToPlain, parseInline, parseMarkdown } from "./markdown-blocks";

describe("Markdown 稳定投影", () => {
  test("标题、列表、引用、代码块与分隔线", () => {
    const plain = markdownToPlain(
      ["# 标题", "", "- 项目一", "1. 项目二", "", "> 引用", "", "```ts", "const a = 1;", "```", "", "---"].join("\n"),
    );
    expect(plain).toContain("标题");
    expect(plain).toContain("• 项目一");
    expect(plain).toContain("1. 项目二");
    expect(plain).toContain("│ 引用");
    expect(plain).toContain("ts");
    expect(plain).toContain("const a = 1;");
    expect(plain).toContain("────");
  });

  test("标识符内的下划线保持字面量，星号强调仍生效", () => {
    expect(markdownToPlain("HELLO_FROM_TOOL")).toBe("HELLO_FROM_TOOL");
    expect(markdownToPlain("a_b_c and `x_y`")).toBe("a_b_c and x_y");
    const runs = parseInline("before **bold** after");
    expect(runs.map((run) => run.text).join("")).toBe("before bold after");
    expect(runs.some((run) => run.bold === true && run.text === "bold")).toBe(true);
  });

  test("行内代码、链接与删除线带语义色", () => {
    const runs = parseInline("`code` [text](https://x.test) ~~gone~~");
    const byText = new Map(runs.map((run) => [run.text, run]));
    expect(byText.get("code")?.token).toBe("mdCode");
    expect(byText.get("text")?.token).toBe("mdLink");
    expect(byText.get(" (https://x.test)")?.token).toBe("mdLinkUrl");
  });

  test("未闭合代码围栏按代码行继续投影（流式安全）", () => {
    const lines = parseMarkdown("```ts\nconst a = 1;\nconst b = 2;");
    expect(lines[0]?.map((run) => run.text).join("")).toBe("ts");
    expect(lines[1]?.map((run) => run.text).join("")).toContain("const a");
    expect(lines[2]?.map((run) => run.text).join("")).toContain("const b");
  });
});
