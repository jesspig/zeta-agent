import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaEditor } from "./editor";
import { ThemeProvider } from "../theme-context";

const commands = [
  { name: "model", description: "选择模型", argumentHint: "<provider/model>" },
  { name: "theme", description: "切换主题" },
  { name: "help", description: "显示帮助" },
];

function renderEditor(onSubmit: (text: string) => void = () => {}) {
  return testRender(
    () => (
      <ThemeProvider initial="dark">
        <ZetaEditor commands={commands} onSubmit={onSubmit} />
      </ThemeProvider>
    ),
    { width: 72, height: 16 },
  );
}

test("输入 / 在输入框下方显示候选命令（含说明与选中标记）", async () => {
  const setup = await renderEditor();
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("/model");
    setup.mockInput.typeText("/");
    await setup.waitForFrame((frame) => frame.includes("→ /model"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("→ /model");
    expect(frame).toContain("<provider/model> — 选择模型");
    expect(frame).toContain("/theme");
    // 候选在输入框下边框之后
    const bottomBorder = frame.split("\n").findIndex((line, index, lines) => index > 0 && line.startsWith("─") && lines[index - 1]?.includes("/"));
    expect(bottomBorder).toBeGreaterThan(0);
  } finally {
    setup.renderer.destroy();
  }
});

test("↑/↓ 选择，Enter 应用并提交斜杠命令", async () => {
  const submitted: string[] = [];
  const setup = await renderEditor((text) => submitted.push(text));
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/");
    await setup.waitForFrame((frame) => frame.includes("→ /model"));
    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((frame) => frame.includes("→ /theme"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => submitted.length === 1);
    expect(submitted).toEqual(["/theme"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("Esc 关闭候选且保留输入", async () => {
  const setup = await renderEditor();
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/");
    await setup.waitForFrame((frame) => frame.includes("→ /model"));
    setup.mockInput.pressEscape();
    await Bun.sleep(120);
    await setup.waitForFrame((frame) => !frame.includes("/model"));
  } finally {
    setup.renderer.destroy();
  }
});

test("Tab 补全后光标停在命令末尾", async () => {
  const setup = await renderEditor();
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/he");
    await setup.waitForFrame((frame) => frame.includes("→ /help"));
    setup.mockInput.pressTab();
    await setup.waitForFrame((frame) => frame.includes("/help") && !frame.includes("→"));
    setup.mockInput.typeText("x");
    await setup.waitForFrame((frame) => frame.includes("/help x"));
    expect(setup.captureCharFrame()).toContain("/help x");
  } finally {
    setup.renderer.destroy();
  }
});

test("过滤：/he 只保留 help", async () => {
  const setup = await renderEditor();
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/he");
    await setup.waitForFrame((frame) => frame.includes("→ /help"));
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("/model");
    expect(frame).toContain("/help");
  } finally {
    setup.renderer.destroy();
  }
});

test("普通输入不显示候选，Enter 提交原文", async () => {
  const submitted: string[] = [];
  const setup = await renderEditor((text) => submitted.push(text));
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("hello");
    await setup.waitForFrame((frame) => frame.includes("hello"));
    expect(setup.captureCharFrame()).not.toContain("/model");
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => submitted.length === 1);
    expect(submitted).toEqual(["hello"]);
  } finally {
    setup.renderer.destroy();
  }
});
