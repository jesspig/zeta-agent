import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";

function renderApp(onSubmit?: (text: string) => void) {
  return testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        onPush={() => {}}
        onSubmit={onSubmit}
        onExit={() => {}}
      />
    ),
    { width: 48, height: 12 },
  );
}

test("T-03 ctrl+o 打开 ModelSelector，Enter 提交选择", async () => {
  const submitted: string[] = [];
  const setup = await renderApp((text) => { submitted.push(text); });
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("GPT-4o");
    setup.mockInput.pressKey("o" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("GPT-4o"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => submitted.length === 1);
    expect(submitted).toEqual(["/model:gpt-4o"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("T-03 ctrl+t 打开 ThemeSelector，Escape 取消", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("t" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("选择主题") || frame.includes("主题"));
    expect(setup.captureCharFrame()).toContain("light");
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    await setup.waitForFrame((frame) => !frame.includes("light") || !frame.includes("选择"));
  } finally {
    setup.renderer.destroy();
  }
});

test("T-03 命令面板内置 model 命令打开 ModelSelector", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("p" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("命令面板"));
    setup.mockInput.typeText("model");
    await setup.waitForFrame((frame) => !frame.includes("theme: 主题"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("GPT-4o"));
  } finally {
    setup.renderer.destroy();
  }
});
