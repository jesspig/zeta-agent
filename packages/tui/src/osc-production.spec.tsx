import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { MarkdownView } from "./components/transcript";
import { OscProvider } from "./osc-context";
import type { OscReporter } from "./osc";

function spyReporter() {
  const copied: string[] = [];
  const linked: string[] = [];
  const reporter: OscReporter = {
    reportProgress() {},
    reportStatus() {},
    markPrompt() {},
    copySelection(text) { copied.push(text); },
    link(uri) { linked.push(uri); },
  };
  return { copied, linked, reporter };
}

describe("A10 OSC 52/8 产线触发", () => {
  test("Markdown 链接在转录渲染时触发 OSC 8 超链接上报", async () => {
    const spy = spyReporter();
    const setup = await testRender(
      () => (
        <OscProvider reporter={spy.reporter}>
          <MarkdownView text="见 [文档](https://example.com/docs)" />
        </OscProvider>
      ),
      { width: 60, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("文档"));
      expect(spy.linked).toContain("https://example.com/docs");
      expect(setup.captureCharFrame()).toContain("https://example.com/docs");
    } finally {
      setup.renderer.destroy();
    }
  });
});
