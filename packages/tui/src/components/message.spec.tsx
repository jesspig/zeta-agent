import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent, AgentMessage } from "@zeta-agent/agent";

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

async function loadComponents() {
  return await import("./message");
}

describe("T-05 消息流与流式渲染", () => {
  test("message_start/message_update/message_end 就地增量渲染，无整屏重建", async () => {
    const { MessageList } = await loadComponents();
    const source = bus();
    const sourceAdapter = { subscribe: source.subscribe };
    let renders = 0;

    const setup = await testRender(
      () => <MessageList source={sourceAdapter} onRender={() => { renders += 1; }} />,
      { width: 50, height: 12 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("IDLE"));

      const partial: AgentMessage = { role: "assistant", content: "Hello" };
      source.emit({ type: "message_start", message: partial });
      await setup.waitForFrame((frame) => frame.includes("Hello"));

      const updated: AgentMessage = { role: "assistant", content: "Hello world" };
      source.emit({
        type: "message_update",
        message: updated,
        assistantMessageEvent: { type: "text_delta", content: " world" },
      });
      await setup.waitForFrame((frame) => frame.includes("Hello world"));
      expect(setup.captureCharFrame()).not.toContain("Hello\nHello");

      const beforeRenders = renders;
      source.emit({ type: "message_end", message: updated });
      await setup.waitForFrame((frame) => frame.includes("[assistant]"));
      expect(renders).toBeGreaterThanOrEqual(beforeRenders);
      expect(setup.captureCharFrame()).not.toContain("Hello world\n[assistant]: Hello world");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("markdown/code 投影渲染：标题标记去除、代码块内容保留", async () => {
    const { markdownPlain } = await loadComponents();
    expect(markdownPlain("# 标题\n\n正文 **粗体**")).toContain("标题");
    expect(markdownPlain("# 标题\n\n正文 **粗体**")).not.toContain("#");
    expect(markdownPlain("行内 `code` 片段")).toContain("code");

    const { CodeContent } = await loadComponents();
    const setup = await testRender(
      () => <CodeContent content={"const x = 1;"} filetype="ts" />,
      { width: 40, height: 4 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("const x = 1;"));
    } finally {
      setup.renderer.destroy();
    }
  });
});
