import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";

function renderApp(onExit: () => void = () => {}) {
  return testRender(
    () => (
      <ZetaApp title="zeta" messages={[]} onPush={() => {}} onExit={onExit} />
    ),
    { width: 60, height: 12 },
  );
}

test("U-02 ctrl+k 不再切换 overlay（归还编辑器 kill），ctrl+g 打开 overlay", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("确定退出");

    setup.mockInput.pressKey("k" as never, { ctrl: true } as never);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("确定退出");

    setup.mockInput.pressKey("g" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("确定退出"));
    expect(setup.captureCharFrame()).toContain("确定退出");
  } finally {
    setup.renderer.destroy();
  }
});

test("U-02 overlay 打开时 Enter 确认并退出", async () => {
  let exited = false;
  const setup = await renderApp(() => { exited = true; });
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("g" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("确定退出"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => exited);
    expect(exited).toBe(true);
  } finally {
    setup.renderer.destroy();
  }
});

test("U-09 Ctrl+P 打开命令面板并执行命令", async () => {
  const submitted: string[] = [];
  const setup = await testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        onPush={() => {}}
        onSubmit={() => {}}
        onCommand={(text) => { submitted.push(text); }}
        onExit={() => {}}
        commandList={[{ id: "custom", title: "Custom command" }]}
      />
    ),
    { width: 60, height: 12 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("p" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("命令面板"));
    setup.mockInput.typeText("custom");
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => submitted.length === 1);
    expect(submitted).toEqual(["/custom"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("U-02 overlay 打开时 Esc 取消且不退出", async () => {
  let exited = false;
  const setup = await renderApp(() => { exited = true; });
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("g" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("确定退出"));
    setup.mockInput.pressKeys(["\x1b"]); // ESC 原始终端序列，转义解析需要短暂缓冲窗口
    await Bun.sleep(30);
    await setup.waitForFrame((frame) => !frame.includes("确定退出"));
    expect(exited).toBe(false);
  } finally {
    setup.renderer.destroy();
  }
});
