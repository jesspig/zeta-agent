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
        modelList={[
          { value: "gpt-4o", name: "GPT-4o", context: "128K", price: "$2.5/$10", effort: ["low", "medium", "high"], reasoning: true, vision: true, group: "openai" },
          { value: "claude-sonnet", name: "Claude Sonnet", context: "200K", price: "$3/$15", effort: [], reasoning: false, vision: true, group: "anthropic" },
        ]}
      />
    ),
    { width: 60, height: 14 },
  );
}

test("T-03 ctrl+l 打开 ModelSelector，Enter 选择后关闭并写入 footer", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("GPT-4o");
    setup.mockInput.pressKey("l" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("GPT-4o"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => !frame.includes("GPT-4o") && frame.includes("gpt-4o"));
    expect(setup.captureCharFrame()).toContain("gpt-4o");
  } finally {
    setup.renderer.destroy();
  }
});

test("未配置 API 时模型选择器不显示模型，仅提示连接", async () => {
  const setup = await testRender(
    () => (
      <ZetaApp title="zeta" messages={[]} onPush={() => {}} onExit={() => {}} />
    ),
    { width: 60, height: 14 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("l" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("未配置 API"));
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("GPT-4o");
    expect(frame).not.toContain("gpt-4o");
  } finally {
    setup.renderer.destroy();
  }
});

test("T-03 命令面板 theme 命令打开 ThemeSelector，Escape 取消", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("p" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("命令面板"));
    setup.mockInput.typeText("theme");
    await setup.waitForFrame((frame) => !frame.includes("theme: 主题") || frame.includes("theme"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("light"));
    expect(setup.captureCharFrame()).toContain("light");
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    await setup.waitForFrame((frame) => !frame.includes("system") || !frame.includes("light"));
  } finally {
    setup.renderer.destroy();
  }
});

test("T-03 命令面板 model 命令打开 ModelSelector", async () => {
  const setup = await renderApp();
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("p" as never, { ctrl: true } as never);
    await setup.waitForFrame((frame) => frame.includes("命令面板"));
    setup.mockInput.typeText("model");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("GPT-4o"));
  } finally {
    setup.renderer.destroy();
  }
});
