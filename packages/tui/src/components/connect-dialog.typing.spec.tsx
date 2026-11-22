import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemeProvider } from "../theme-context";
import { ConnectDialog } from "./connect-dialog";

/** CR-13：手输凭据的大小写必须保留。 */
test("手输大写字符保留原始大小写", async () => {
  let submitted: { url: string; key: string } | undefined;
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <ConnectDialog
          onSubmit={(url, key) => { submitted = { url, key }; }}
          onCancel={() => {}}
        />
      </ThemeProvider>
    ),
    { width: 70, height: 10 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("HTTPS://Api.Example.COM/V1");
    await setup.waitForFrame((f) => f.includes("HTTPS://Api"));
    setup.mockInput.pressTab();
    setup.mockInput.typeText("AbCdEf123");
    await new Promise((r) => setTimeout(r, 30));
    setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted?.url).toBe("HTTPS://Api.Example.COM/V1");
    expect(submitted?.key).toBe("AbCdEf123");
  } finally {
    setup.renderer.destroy();
  }
});
