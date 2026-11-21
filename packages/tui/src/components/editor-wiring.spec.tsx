import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaEditor } from "./editor";

describe("U-02 编辑器交互接线（真实键盘）", () => {
  test("输入文字后 Ctrl+K 触发 kill-to-end，文本从帧消失", async () => {
    const setup = await testRender(() => <ZetaEditor onSubmit={() => {}} />, {
      width: 48,
      height: 6,
    });
    try {
      setup.mockInput.typeText("secret-text");
      await setup.waitForFrame((frame) => frame.includes("secret-text"));
      expect(setup.captureCharFrame()).toContain("secret-text");

      setup.mockInput.pressKey("k" as never, { ctrl: true } as never);
      await setup.waitForFrame((frame) => !frame.includes("secret-text"));
      expect(setup.captureCharFrame()).not.toContain("secret-text");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("提交后按 Up 恢复上一条历史", async () => {
    const submitted: string[] = [];
    const setup = await testRender(
      () => <ZetaEditor onSubmit={(t) => { submitted.push(t); }} />,
      { width: 48, height: 6 },
    );
    try {
      setup.mockInput.typeText("remember-me");
      await setup.waitForFrame((frame) => frame.includes("remember-me"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame(() => submitted.length === 1);
      expect(submitted).toEqual(["remember-me"]);

      setup.mockInput.pressArrow("up");
      await setup.waitForFrame((frame) => frame.includes("remember-me"));
      expect(setup.captureCharFrame()).toContain("remember-me");
    } finally {
      setup.renderer.destroy();
    }
  });
});
