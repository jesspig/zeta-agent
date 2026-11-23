import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { OscProvider } from "../osc-context";
import type { OscReporter } from "../osc";
import { ZetaEditor, type SubmitMode } from "./editor";

function oscSpy() {
  const copied: string[] = [];
  const linked: string[] = [];
  const reporter: OscReporter = {
    reportProgress() {},
    reportStatus() {},
    markPrompt() {},
    copySelection(text) { copied.push(text); },
    link(uri) { linked.push(uri); },
  };
  return { copied, linked, reporter };
}

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

  test("Alt+Enter 以 follow-up 模式提交，Alt+Up 从队列取回；Enter 仍是 steer", async () => {
    const submitted: Readonly<{ text: string; mode: SubmitMode }>[] = [];
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmit={() => {}}
          onSubmitWithMode={(text, mode) => {
            submitted.push({ text, mode });
          }}
        />
      ),
      { width: 48, height: 8 },
    );
    try {
      await setup.renderOnce();
      setup.mockInput.typeText("queued-message");
      await setup.waitForFrame((frame) => frame.includes("queued-message"));

      setup.mockInput.pressEnter({ meta: true });
      await setup.waitForFrame(() => submitted.length === 1);
      expect(submitted).toEqual([{ text: "queued-message", mode: "follow-up" }]);
      await setup.waitForFrame((frame) => !frame.includes("queued-message"));
      expect(setup.captureCharFrame()).not.toContain("queued-message");

      setup.mockInput.pressArrow("up", { meta: true });
      await setup.waitForFrame((frame) => frame.includes("queued-message"));
      expect(setup.captureCharFrame()).toContain("queued-message");

      setup.mockInput.pressEnter();
      await setup.waitForFrame(() => submitted.length === 2);
      expect(submitted[1]).toEqual({ text: "queued-message", mode: "steer" });
    } finally {
      setup.renderer.destroy();
    }
  });

  test("Ctrl+Shift+C 通过 OSC 52 复制当前输入到剪贴板", async () => {
    const spy = oscSpy();
    const setup = await testRender(
      () => (
        <OscProvider reporter={spy.reporter}>
          <ZetaEditor onSubmit={() => {}} />
        </OscProvider>
      ),
      { width: 48, height: 6, kittyKeyboard: true },
    );
    try {
      await setup.renderOnce();
      setup.mockInput.typeText("copy-me");
      await setup.waitForFrame((frame) => frame.includes("copy-me"));
      setup.mockInput.pressKey("c" as never, { ctrl: true, shift: true } as never);
      await Bun.sleep(0);
      expect(spy.copied).toContain("copy-me");
      // 复制不清空编辑器（与 Ctrl+C 的清空语义区分）。
      expect(setup.captureCharFrame()).toContain("copy-me");
    } finally {
      setup.renderer.destroy();
    }
  });
});
