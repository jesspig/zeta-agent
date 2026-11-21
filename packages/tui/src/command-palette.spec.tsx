import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { CommandPaletteView, type Command } from "./command-palette";

const COMMANDS: readonly Command[] = [
  { id: "clear", title: "Clear transcript" },
  { id: "exit", title: "Exit session" },
  { id: "model", title: "Switch model" },
];

test("U-09 命令面板：过滤、方向键导航、Enter 执行", async () => {
  const run: string[] = [];
  const setup = await testRender(
    () => (
      <CommandPaletteView
        commands={COMMANDS}
        onRun={(command) => { run.push(command.id); }}
        onCancel={() => {}}
      />
    ),
    { width: 48, height: 8 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("clear"));
    expect(setup.captureCharFrame()).toContain("Exit session");

    setup.mockInput.typeText("exit");
    await setup.waitForFrame((frame) => !frame.includes("Clear transcript"));
    expect(setup.captureCharFrame()).toContain("Exit session");

    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => run.length === 1);
    expect(run).toEqual(["exit"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("U-09 命令面板：↑↓ 改变选中项", async () => {
  const setup = await testRender(
    () => <CommandPaletteView commands={COMMANDS} onRun={() => {}} onCancel={() => {}} />,
    { width: 48, height: 8 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("> clear"));
    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((frame) => frame.includes("> exit"));
    setup.mockInput.pressArrow("up");
    await setup.waitForFrame((frame) => frame.includes("> clear"));
  } finally {
    setup.renderer.destroy();
  }
});
