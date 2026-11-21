import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent } from "@zeta-agent/agent";
import { ZetaApp } from "./runtime";

type Listener = (event: AgentEvent) => void;

function fakeSource() {
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

test("ZetaApp 在提供 source 时正确解包 Show accessor 并渲染富消息列表", async () => {
  const source = fakeSource();
  const setup = await testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        source={source}
        onPush={() => {}}
        onExit={() => {}}
      />
    ),
    { width: 50, height: 12 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("New session started"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("New session started");
    expect(frame).not.toContain("subscribe is not a function");
  } finally {
    setup.renderer.destroy();
  }
});
