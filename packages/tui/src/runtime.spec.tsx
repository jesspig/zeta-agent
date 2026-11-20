import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaFrame } from "./runtime";

test("OpenTUI 原生渲染 TUI 帧：含消息文本且无自研 ASCII 边框", async () => {
  const setup = await testRender(
    () => (
      <ZetaFrame
        title="zeta v0.1.0"
        lines={["user: hello", "assistant: world"]}
      />
    ),
    { width: 40, height: 10 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
    expect(frame).not.toContain("+---");
    expect(frame).not.toContain("|user:");
  } finally {
    setup.renderer.destroy();
  }
});
