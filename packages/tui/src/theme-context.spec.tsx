import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemeProvider, useTheme } from "./theme-context";

function ThemeProbe() {
  const theme = useTheme();
  return <text>{`${theme.name()}:${theme.color("accent")}`}</text>;
}

describe("U-04 主题接线", () => {
  test("Provider 提供 token 色，切换主题后色值精细更新", async () => {
    let innerSet: ((name: string) => void) | undefined;
    const setup = await testRender(
      () => (
        <ThemeProvider initial="dark">
          {(() => {
            const theme = useTheme();
            innerSet = theme.setActive;
            return <ThemeProbe />;
          })()}
        </ThemeProvider>
      ),
      { width: 40, height: 3 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("dark:#a798d7"));
      innerSet?.("light");
      await setup.waitForFrame((frame) => frame.includes("light:#7459b4"));
      expect(setup.captureCharFrame()).toContain("light:#7459b4");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("无 Provider 时回退 dark，组件独立可测", async () => {
    const setup = await testRender(() => <ThemeProbe />, { width: 40, height: 3 });
    try {
      await setup.waitForFrame((frame) => frame.includes("dark:#a798d7"));
    } finally {
      setup.renderer.destroy();
    }
  });
});
