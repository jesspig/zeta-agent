import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { contextBudget, renderHudPanel } from "./hud";
import { createOscReporter, oscSequence } from "./osc";
import { FooterView } from "./components/footer";
import { resolveDualMode } from "./dual-mode";

describe("T-12 状态栏/hud/OSC", () => {
  test("footer 显示模型/状态/上下文预算字段", async () => {
    const setup = await testRender(
      () => (
        <FooterView
          model="gpt-4"
          status="streaming"
          budget={contextBudget(70, 100)}
        />
      ),
      { width: 60, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("gpt-4"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("streaming");
      expect(frame).toContain("70%");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("hud 面板接入预算条", () => {
    const budget = contextBudget(90, 100);
    expect(budget.level).toBe("critical");
    expect(renderHudPanel(budget)).toContain("CTX 90/100");
  });

  test("OSC 7501/9;4 上报调用可 spy", () => {
    const writes: string[] = [];
    const reporter = createOscReporter((sequence) => writes.push(sequence));
    reporter.reportProgress(42);
    reporter.reportStatus("working");
    expect(writes.some((write) => write.includes("7501"))).toBe(true);
    expect(writes.some((write) => write.includes("9;4"))).toBe(true);
    expect(oscSequence("progress", 50)).toContain("\x1b]7501");
  });

  test("O-12 双模式：regular 保留 scrollback，fullscreen 用 alt-screen", () => {
    const regular = resolveDualMode("regular");
    expect(regular.screenMode).toBe("main-screen");
    expect(regular.preservesScrollback).toBe(true);
    const fullscreen = resolveDualMode("fullscreen");
    expect(fullscreen.screenMode).toBe("alternate-screen");
    expect(fullscreen.preservesScrollback).toBe(false);
  });
});
