import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";

type Listener = (event: AgentEvent) => void;

function bus() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

describe("T-06 工具盒与 diff/thinking", () => {
  test("工具三态标记：running/done/error", async () => {
    const { ToolBox } = await import("./tool-box");
    const source = bus();
    const setup = await testRender(() => <ToolBox source={source} />, { width: 50, height: 8 });
    try {
      source.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
      await setup.waitForFrame((frame) => frame.includes("read"));
      expect(setup.captureCharFrame()).toContain("running");

      source.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false, durationMs: 12 });
      await setup.waitForFrame((frame) => frame.includes("done"));

      source.emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "write", result: "bad", isError: true });
      await setup.waitForFrame((frame) => frame.includes("error"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("折叠/展开：默认隐藏 args，toggle 后可见", async () => {
    const { ToolBox, createToolBoxController } = await import("./tool-box");
    const source = bus();
    const controller = createToolBoxController();

    const setup = await testRender(
      () => <ToolBox source={source} controller={controller} />,
      { width: 60, height: 8 },
    );
    try {
      source.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: { pattern: "secret-pattern" } });
      await setup.waitForFrame((frame) => frame.includes("grep"));
      expect(setup.captureCharFrame()).not.toContain("secret-pattern");
      controller.toggle("t1");
      await setup.waitForFrame((frame) => frame.includes("secret-pattern"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("diff 行级反显与词级标记", async () => {
    const { diffLines } = await import("./diff-view");
    const lines = diffLines("old line\nshared tail", "new line\nshared tail");
    expect(lines.some((line) => line.op === "remove" && line.text.includes("old"))).toBe(true);
    expect(lines.some((line) => line.op === "add" && line.text.includes("new"))).toBe(true);
    expect(lines.some((line) => line.op === "context" && line.text.includes("shared"))).toBe(true);

    const words = diffLines("the quick fox", "the slow fox");
    expect(words.some((line) => line.wordDiff?.kind === "replace")).toBe(true);
  });

  test("thinking 折叠：默认显示摘要，展开后显示全文", async () => {
    const { ThinkingBlock } = await import("./thinking");
    const setup = await testRender(
      () => <ThinkingBlock text={"思考很长很长的理由"} expanded={false} />,
      { width: 40, height: 4 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("thinking"));
      expect(setup.captureCharFrame()).not.toContain("思考很长很长的理由");
    } finally {
      setup.renderer.destroy();
    }
  });
});
