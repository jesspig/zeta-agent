import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";
import { createSignal, type EventSource } from "../signal";
import { Transcript } from "./transcript";
import { ThemeProvider } from "../theme-context";

function eventSource(): { source: EventSource; emit: (event: AgentEvent) => void } {
  const signal = createSignal<AgentEvent | null>(null);
  return {
    source: {
      subscribe(listener) {
        return signal.subscribe((event) => {
          if (event !== null) listener(event);
        });
      },
    },
    emit: (event) => signal.set(event),
  };
}

function rowOf(frame: string, marker: string): number {
  const index = frame.split("\n").findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`帧中未找到: ${marker}\n${frame}`);
  return index;
}

test("对话按顺序内联渲染：用户 → 思考 → 助手 → 工具 → 助手", async () => {
  const { source, emit } = eventSource();
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <Transcript source={source} cwd="/repo" />
      </ThemeProvider>
    ),
    { width: 80, height: 30 },
  );
  try {
    await setup.renderOnce();
    emit({ type: "message_start", message: { role: "user", content: "请读文件" } });
    emit({ type: "message_end", message: { role: "user", content: "请读文件" } });
    emit({ type: "message_start", message: { role: "assistant", content: "" } });
    emit({
      type: "message_update",
      message: { role: "assistant", content: "我先看看", thinking: "需要读取源码" },
      assistantMessageEvent: { type: "text_delta", delta: "我先看看" },
    });
    emit({ type: "message_end", message: { role: "assistant", content: "我先看看", thinking: "需要读取源码" } });
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/repo/src/a.ts" } });
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: { ok: true, content: "SECRET_CONTENT" },
      isError: false,
      durationMs: 40,
    });
    emit({ type: "message_start", message: { role: "assistant", content: "" } });
    emit({ type: "message_end", message: { role: "assistant", content: "读完了" } });
    emit({ type: "agent_end", messages: [] });

    await setup.waitForFrame((frame) => frame.includes("读完了"));
    const frame = setup.captureCharFrame();

    const userRow = rowOf(frame, "请读文件");
    const thinkingRow = rowOf(frame, "需要读取源码");
    const assistantRow = rowOf(frame, "我先看看");
    const toolRow = rowOf(frame, "read src/a.ts");
    const finalRow = rowOf(frame, "读完了");
    expect(userRow).toBeLessThan(thinkingRow);
    expect(thinkingRow).toBeLessThan(assistantRow);
    expect(assistantRow).toBeLessThan(toolRow);
    expect(toolRow).toBeLessThan(finalRow);

    // read 折叠时不显示文件内容；工具块使用成功背景色。
    expect(frame).not.toContain("SECRET_CONTENT");
    const spans = setup.captureSpans();
    let toolBg: number[] | null = null;
    for (const line of spans.lines) {
      const header = line.spans.map((span) => span.text).join("");
      if (!header.includes("read src/a.ts")) continue;
      for (const span of line.spans) {
        const rgba = span.bg.toInts();
        if ((rgba[3] ?? 0) > 0) {
          toolBg = rgba;
          break;
        }
      }
    }
    expect(toolBg).not.toBeNull();
    const bg = toolBg ?? [0, 0, 0, 0];
    expect((bg[1] ?? 0) > (bg[2] ?? 0)).toBe(true); // toolSuccessBg 偏绿

    // Ctrl+O 展开工具输出。
    setup.mockInput.pressKey("o" as never, { ctrl: true } as never);
    await setup.waitForFrame((next) => next.includes("SECRET_CONTENT"));
  } finally {
    setup.renderer.destroy();
  }
});

test("Ctrl+T 折叠/展开思考正文", async () => {
  const { source, emit } = eventSource();
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <Transcript source={source} />
      </ThemeProvider>
    ),
    { width: 80, height: 16 },
  );
  try {
    await setup.renderOnce();
    emit({ type: "message_start", message: { role: "assistant", content: "" } });
    emit({
      type: "message_end",
      message: { role: "assistant", content: "答案", thinking: "需要读取源码" },
    });
    // 默认展开（与目标终端 UI 的 hideThinkingBlock=false 对齐）。
    await setup.waitForFrame((frame) => frame.includes("需要读取源码"));
    setup.mockInput.pressKey("t" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("Thinking..."));
    expect(setup.captureCharFrame()).not.toContain("需要读取源码");
    setup.mockInput.pressKey("t" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("需要读取源码"));
  } finally {
    setup.renderer.destroy();
  }
});

test("空会话显示 New session started 与加载资源", async () => {
  const { source } = eventSource();
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <Transcript
          source={source}
          resources={{ models: ["gpt-4o"], prompts: ["review"], extensions: ["mcp"] }}
        />
      </ThemeProvider>
    ),
    { width: 80, height: 20 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("New session started"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[Models] gpt-4o");
    expect(frame).toContain("[Prompts] /review");
    expect(frame).toContain("[Extensions] mcp");
  } finally {
    setup.renderer.destroy();
  }
});
