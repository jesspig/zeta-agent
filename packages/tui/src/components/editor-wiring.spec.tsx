import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { OscProvider } from "../osc-context";
import type { OscReporter } from "../osc";
import { ZetaEditor, type EditorHandle, type SubmitMode } from "./editor";

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

  test("Shift+Enter 插入换行且不提交", async () => {
    let submitted = 0;
    let handle: EditorHandle | undefined;
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmit={() => { submitted += 1; }}
          onHandle={(value) => { handle = value; }}
        />
      ),
      { width: 48, height: 6, kittyKeyboard: true },
    );
    try {
      setup.mockInput.typeText("first-line");
      await setup.waitForFrame((frame) => frame.includes("first-line"));
      setup.mockInput.pressEnter({ shift: true });
      await Bun.sleep(10);
      expect(submitted).toBe(0);
      expect(handle?.value()).toContain("\n");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("宿主拒绝或抛错时保留草稿", async () => {
    let handle: EditorHandle | undefined;
    const errors: unknown[] = [];
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmitWithMode={async () => false}
          onSubmitError={(error) => errors.push(error)}
          onHandle={(value) => { handle = value; }}
        />
      ),
      { width: 48, height: 6 },
    );
    try {
      setup.mockInput.typeText("keep-draft");
      await setup.waitForFrame((frame) => frame.includes("keep-draft"));
      setup.mockInput.pressEnter();
      await Bun.sleep(0);
      expect(handle?.value()).toBe("keep-draft");
      expect(errors).toEqual([]);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("候选菜单打开时 Shift+Enter 只插入换行", async () => {
    let submitted = 0;
    let handle: EditorHandle | undefined;
    const setup = await testRender(
      () => (
        <ZetaEditor
          commands={[{ name: "quit", description: "退出" }]}
          onSubmitWithMode={() => { submitted += 1; }}
          onHandle={(value) => { handle = value; }}
        />
      ),
      { width: 48, height: 8, kittyKeyboard: true },
    );
    try {
      setup.mockInput.typeText("/q");
      await setup.waitForFrame((frame) => frame.includes("/quit"));
      setup.mockInput.pressEnter({ shift: true });
      await Bun.sleep(10);
      expect(submitted).toBe(0);
      expect(handle?.value()).toContain("\n");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("异步提交期间的新输入不会在接受后被清空", async () => {
    let release: (() => void) | undefined;
    let handle: EditorHandle | undefined;
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmitWithMode={() => new Promise<boolean>((resolve) => { release = () => resolve(true); })}
          onHandle={(value) => { handle = value; }}
        />
      ),
      { width: 48, height: 6 },
    );
    try {
      setup.mockInput.typeText("first");
      await setup.waitForFrame((frame) => frame.includes("first"));
      setup.mockInput.pressEnter();
      setup.mockInput.typeText(" second");
      await setup.waitForFrame((frame) => frame.includes("second"));
      release?.();
      await Bun.sleep(10);
      expect(handle?.value()).toBe("first second");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("异步提交期间重复 Enter 不会触发二次提交", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmitWithMode={() => {
            calls += 1;
            return new Promise<boolean>((resolve) => { release = () => resolve(true); });
          }}
        />
      ),
      { width: 48, height: 6 },
    );
    try {
      setup.mockInput.typeText("once-only");
      await setup.waitForFrame((frame) => frame.includes("once-only"));
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await Bun.sleep(0);
      expect(calls).toBe(1);
      release?.();
      await setup.waitForFrame((frame) => !frame.includes("once-only"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("宿主异步拒绝时保留草稿并报告错误", async () => {
    let handle: EditorHandle | undefined;
    const errors: unknown[] = [];
    const setup = await testRender(
      () => (
        <ZetaEditor
          onSubmitWithMode={async () => { throw new Error("busy"); }}
          onSubmitError={(error) => errors.push(error)}
          onHandle={(value) => { handle = value; }}
        />
      ),
      { width: 48, height: 6 },
    );
    try {
      setup.mockInput.typeText("keep-on-error");
      await setup.waitForFrame((frame) => frame.includes("keep-on-error"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame(() => errors.length === 1);
      expect(handle?.value()).toBe("keep-on-error");
      expect((errors[0] as Error).message).toBe("busy");
    } finally {
      setup.renderer.destroy();
    }
  });
});
