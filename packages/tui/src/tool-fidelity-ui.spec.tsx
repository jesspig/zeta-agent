import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { CapturedFrame } from "@opentui/core";
import type { AgentEvent } from "@zeta-agent/agent";
import { createToolBoxController, ToolBox } from "./components/tool-box";

type Listener = (event: AgentEvent) => void;

function bus() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function bgOf(frame: CapturedFrame, marker: string): number[] | null {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(marker)) return span.bg.toInts();
    }
  }
  return null;
}

describe("T-06 工具盒 UI 增强", () => {
  test("三态背景通过 box backgroundColor 反映到 span.bg", async () => {
    const source = bus();
    const setup = await testRender(() => <ToolBox source={source} />, { width: 60, height: 12 });
    try {
      source.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
      await setup.waitForFrame((frame) => frame.includes("read"));
      source.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: {} });
      source.emit({ type: "tool_execution_start", toolCallId: "t3", toolName: "write", args: {} });
      source.emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "grep", result: "ok", isError: false, durationMs: 1 });
      source.emit({ type: "tool_execution_end", toolCallId: "t3", toolName: "write", result: "bad", isError: true });
      await setup.waitForFrame((frame) => frame.includes("error") && frame.includes("done"));

      const spans = setup.captureSpans();
      const pendingBg = bgOf(spans, "read");
      const successBg = bgOf(spans, "grep");
      const errorBg = bgOf(spans, "write");
      expect(pendingBg).not.toBeNull();
      expect(successBg).not.toBeNull();
      expect(errorBg).not.toBeNull();
      expect(pendingBg).not.toEqual(successBg);
      expect(successBg).not.toEqual(errorBg);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("预览 >10 行折叠提示 + Ctrl+O 展开", async () => {
    const source = bus();
    const controller = createToolBoxController();
    const setup = await testRender(
      () => <ToolBox source={source} controller={controller} />,
      { width: 60, height: 20 },
    );
    try {
      const lines = Array.from({ length: 15 }, (_, i) => `LINE_${String(i).padStart(2, "0")}`).join("\n");
      source.emit({ type: "tool_execution_start", toolCallId: "p1", toolName: "preview", args: {} });
      source.emit({
        type: "tool_execution_end",
        toolCallId: "p1",
        toolName: "preview",
        result: lines,
        isError: false,
        durationMs: 1,
      });
      await setup.waitForFrame((frame) => frame.includes("preview"));
      expect(setup.captureCharFrame()).toContain("Ctrl+O to expand");
      expect(setup.captureCharFrame()).not.toContain("LINE_14");

      setup.mockInput.pressKey("o" as never, { ctrl: true } as never);
      await setup.waitForFrame((frame) => frame.includes("LINE_14"));
      expect(setup.captureCharFrame()).not.toContain("Ctrl+O to expand");
    } finally {
      setup.renderer.destroy();
    }
  });
});
