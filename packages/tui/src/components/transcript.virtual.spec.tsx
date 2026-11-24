import { expect, test } from "bun:test";
import type { AgentMessage } from "@zeta-agent/agent";
import { createSignal, type EventSource } from "../signal";
import { ThemeProvider } from "../theme-context";
import { Transcript } from "./transcript";

async function probeNative(): Promise<boolean> {
  try {
    const solid = await import("@opentui/solid");
    return typeof solid.testRender === "function";
  } catch {
    return false;
  }
}

const nativeAvailable = await probeNative();

function emptySource(): EventSource {
  const signal = createSignal<unknown>(null);
  return { subscribe: (listener) => signal.subscribe(() => {}) };
}

test.skipIf(!nativeAvailable)("10k-entry transcript keeps rendered nodes and frame time bounded", async () => {
  const { testRender } = await import("@opentui/solid");
  const messages = Array.from(
    { length: 10_000 },
    (_, index) => ({ role: "user", content: `msg-${index}` }) as AgentMessage,
  );
  let rendered = 0;
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <Transcript source={emptySource()} initialMessages={messages} onRenderEntry={() => { rendered += 1; }} />
      </ThemeProvider>
    ),
    { width: 60, height: 12 },
  );
  try {
    const started = performance.now();
    await setup.renderOnce();
    const elapsed = performance.now() - started;
    const frame = setup.captureCharFrame();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(30);
    expect(frame).toMatch(/msg-99\d\d/);
    expect(frame).not.toContain("msg-1\n");
    expect(elapsed).toBeLessThan(3_000);
  } finally {
    setup.renderer.destroy();
  }
});
