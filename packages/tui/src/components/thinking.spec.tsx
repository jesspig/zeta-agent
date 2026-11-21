import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThinkingBlock } from "./thinking";

test("U-07 thinking 折叠交互：Ctrl+T 切换展开/折叠全文", async () => {
  const setup = await testRender(
    () => <ThinkingBlock text="SECRET_REASONING_BODY" expanded={false} />,
    { width: 48, height: 8 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("thinking"));
    expect(setup.captureCharFrame()).not.toContain("SECRET_REASONING_BODY");

    setup.mockInput.pressKey("t" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("SECRET_REASONING_BODY"));
    expect(setup.captureCharFrame()).toContain("SECRET_REASONING_BODY");

    setup.mockInput.pressKey("t" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => !frame.includes("SECRET_REASONING_BODY"));
    expect(setup.captureCharFrame()).not.toContain("SECRET_REASONING_BODY");
  } finally {
    setup.renderer.destroy();
  }
});
