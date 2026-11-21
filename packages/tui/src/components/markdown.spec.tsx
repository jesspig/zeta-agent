import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { CodeContent, MarkdownContent, markdownPlain } from "./markdown";

describe("U-08 markdown/code 渲染", () => {
  test("markdownPlain 去除常见标记", () => {
    expect(markdownPlain("# 标题\n\n正文 **粗体** 与 `code`")).toContain("标题");
    expect(markdownPlain("**粗体**")).toBe("粗体");
  });

  test("围栏代码块带语言标签渲染，正文投影渲染", async () => {
    const setup = await testRender(
      () => (
        <box flexDirection="column">
          <MarkdownContent content={"# 标题\n\n```ts\nconst x = 1\n```\n\n结尾"} />
        </box>
      ),
      { width: 50, height: 12 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("[ts]"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("标题");
      expect(frame).toContain("const x = 1");
      expect(frame).toContain("结尾");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("CodeContent 无 filetype 时不显示标签", async () => {
    const setup = await testRender(() => <CodeContent content="plain code" />, {
      width: 40,
      height: 4,
    });
    try {
      await setup.waitForFrame((frame) => frame.includes("plain code"));
      expect(setup.captureCharFrame()).not.toContain("[");
    } finally {
      setup.renderer.destroy();
    }
  });
});
