import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { CountdownTimer, formatCountdown, Loader, SPINNER_FRAMES, spinnerAtMs } from "./components/loader";

describe("T-08 动效：spinner 与倒计时", () => {
  test("spinner 帧序列：10 帧 braille，每 80ms 推进一帧并循环", () => {
    expect(SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    expect(spinnerAtMs(0)).toBe("⠋");
    expect(spinnerAtMs(79)).toBe("⠋");
    expect(spinnerAtMs(80)).toBe("⠙");
    expect(spinnerAtMs(800)).toBe("⠋");
  });

  test("formatCountdown：毫秒 → m:ss，负值归零", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(5000)).toBe("0:05");
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(-100)).toBe("0:00");
  });

  test("Loader 渲染初始 spinner 帧与标签", async () => {
    const setup = await testRender(() => <Loader label="加载中" />, { width: 40, height: 3 });
    try {
      await setup.waitForFrame((frame) => frame.includes("加载中"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("⠋");
      expect(frame).toContain("加载中");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("CountdownTimer 渲染格式化剩余时间", async () => {
    const setup = await testRender(() => <CountdownTimer remainingMs={5000} />, { width: 20, height: 3 });
    try {
      await setup.waitForFrame((frame) => frame.includes("0:05"));
      expect(setup.captureCharFrame()).toContain("0:05");
    } finally {
      setup.renderer.destroy();
    }
  });
});
