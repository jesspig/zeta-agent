import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { contextBudget } from "./hud";
import {
  composeRow,
  contextColorToken,
  foldHome,
  FooterView,
  formatTokens,
  truncateWithGap,
  type FooterMetrics,
} from "./components/footer";

const METRICS: FooterMetrics = {
  inputTokens: 1200,
  outputTokens: 3400,
  cacheReadTokens: 9000,
  cacheWriteTokens: 1500,
  cacheHitPercent: 75,
  costUsd: 0.42,
};

describe("T-04 Footer 高保真", () => {
  test("formatTokens：<1000 原样、x.xk、Nk、x.xM、NM", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(12345)).toBe("12k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  test("foldHome：仅折叠 home 前缀，其他路径原样", () => {
    expect(foldHome("/home/jesspig/project", "/home/jesspig")).toBe("~/project");
    expect(foldHome("/home/jesspig", "/home/jesspig")).toBe("~");
    expect(foldHome("/other/project", "/home/jesspig")).toBe("/other/project");
  });

  test("truncateWithGap / composeRow：截断保底 2 空格间距", () => {
    expect(truncateWithGap("abcdefghij", "RIGHT", 12)).toBe("abcde  RIGHT");
    expect(truncateWithGap("abc", "RIGHT", 6)).toBe("  RIGHT");
    const row = composeRow("LEFT", "RIGHT", 20);
    expect(row).toBe("LEFT" + " ".repeat(11) + "RIGHT");
    expect(row.length).toBe(20);
  });

  test("contextColorToken：>70 黄、>90 红、其余 muted", () => {
    expect(contextColorToken(50)).toBe("muted");
    expect(contextColorToken(71)).toBe("warning");
    expect(contextColorToken(91)).toBe("error");
  });

  test("三行结构：pwd(home折叠)+git分支+会话名 / 指标+上下文+右对齐模型 / setStatus 扩展行", async () => {
    const setup = await testRender(
      () => (
        <FooterView
          model="gpt-4"
          status="streaming"
          budget={contextBudget(70, 100)}
          pwd="/home/jesspig/project"
          home="/home/jesspig"
          branch="main"
          session="zeta"
          metrics={METRICS}
          provider="anthropic"
          modelId="claude-sonnet"
          thinking
          statusText="indexing files"
        />
      ),
      { width: 80, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("indexing files"));
      const lines = setup.captureCharFrame().split("\n").filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(3);

      const [row1, row2, row3] = lines as [string, string, string];
      expect(row1).toContain("~/project");
      expect(row1).toContain("(main)");
      expect(row1).toContain("zeta");

      expect(row2).toContain("↑");
      expect(row2).toContain("↓");
      expect(row2).toContain("R");
      expect(row2).toContain("W");
      expect(row2).toContain("CH");
      expect(row2).toContain("$");
      expect(row2).toContain("ctx 70%");
      expect(row2).toContain("claude-sonnet");
      expect(row2).toContain("anthropic");
      expect(row2).toContain("thinking");

      expect(row3).toContain("gpt-4 streaming");
      expect(row3).toContain("indexing files");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("未传遥测时降级为单行兼容模式，不抛错且保留 ctx 百分比", async () => {
    const setup = await testRender(
      () => <FooterView model="zeta" status="idle" budget={contextBudget(0, 100)} />,
      { width: 60, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("ctx 0%"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("zeta idle ctx 0%");
      expect(frame.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
    } finally {
      setup.renderer.destroy();
    }
  });
});
