import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemeProvider } from "../../theme-context";
import { SelectDialog, type SelectOption } from "./selectors";

/** 补审 CR-S05：光标只能在可见选项内移动，不能确认从未显示的项。 */
test("长列表时光标停在可见范围内，确认项为屏幕上可见项", async () => {
  const options: SelectOption[] = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
  let chosen: string | undefined;
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <SelectDialog title="选择" options={options} onSelect={(o) => { chosen = o.value; }} onCancel={() => {}} />
      </ThemeProvider>
    ),
    { width: 60, height: 14 },
  );
  try {
    await setup.renderOnce();
    for (let i = 0; i < 20; i += 1) setup.mockInput.pressArrow("down");
    // 等待滚动后出现靠后的选项（证明窗口随光标移动）
    await setup.waitForFrame((f) => f.includes("Option 20"));
    const frame = setup.captureCharFrame();
    setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 30));
    // 确认项必须在屏幕上可见
    expect(chosen).toBeDefined();
    expect(frame).toContain(`Option ${chosen!.slice(1)}`);
  } finally {
    setup.renderer.destroy();
  }
});
