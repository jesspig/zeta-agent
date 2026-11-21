import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";
import { createSignal, type EventSource } from "./signal";
import type { AgentEvent } from "@zeta-agent/agent";

function sourceWithEvents(events: readonly AgentEvent[]): EventSource {
  const s = createSignal<AgentEvent | null>(null);
  const source: EventSource = {
    subscribe(listener) {
      const off = s.subscribe((e) => {
        if (e) listener(e);
      });
      return off;
    },
  };
  setTimeout(() => {
    for (const e of events) s.set(e);
  }, 50);
  return source;
}

const noop = () => {};

test("UI 视觉验收：用户消息高亮块 + 双行 footer", async () => {
  const user = { role: "user" as const, content: "你好" };
  const assistant = { role: "assistant" as const, content: "你好！有什么可以帮你的吗？" };
  const source = sourceWithEvents([
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: user },
    { type: "message_start", message: assistant },
    { type: "message_end", message: assistant },
    { type: "turn_end", message: assistant, toolResults: [] },
    { type: "agent_end", messages: [user, assistant] },
  ]);
  const setup = await testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        source={source}
        onPush={() => {}}
        onSubmit={noop}
        onExit={noop}
      />
    ),
    { width: 100, height: 30 },
  );
  try {
    await Bun.sleep(120);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    console.log("===== FRAME =====");
    console.log(frame);
    console.log("===== END =====");
    expect(frame).toContain("你好");
    // footer 双行：第一行含分支，第二行含 ctx
    expect(frame).toContain("ctx");
    // 用户消息必须有蓝色高亮背景（RGBA alpha 非 0，且蓝色通道显著）
    const frame2 = setup.captureSpans();
    let userBg: number[] | null = null;
    for (const line of frame2.lines) {
      for (const span of line.spans) {
        if (span.text.includes("你好") && span.bg.toInts()[3] > 0) userBg = span.bg.toInts();
      }
    }
    expect(userBg).not.toBeNull();
    const bg = userBg ?? [0, 0, 0, 0];
    expect((bg[2] ?? 0) > (bg[0] ?? 0)).toBe(true);
  } finally {
    setup.renderer.destroy();
  }
});
