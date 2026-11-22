import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemeProvider, useTheme } from "./theme-context";

/** CR-32：主题切换后，之前取到的 theme.color() 必须反映新调色板。 */
test("主题切换后 color 返回新调色板的色值", async () => {
  let setActive!: (name: string) => void;
  let theme!: ReturnType<typeof useTheme>;
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        {(() => {
          const t = useTheme();
          setActive = t.setActive;
          theme = t;
          return <text>{t.color("accent")}</text>;
        })()}
      </ThemeProvider>
    ),
    { width: 40, height: 3 },
  );
  try {
    await setup.renderOnce();
    const dark = theme.color("accent");
    setActive("light");
    const light = theme.color("accent");
    expect(dark).not.toBe(light);
  } finally {
    setup.renderer.destroy();
  }
});
