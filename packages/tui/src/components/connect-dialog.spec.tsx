import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemeProvider } from "../theme-context";
import { ConnectDialog } from "./connect-dialog";

function renderDialog( onSubmit: (url: string, key: string) => void ) {
  return testRender(
    () => (
      <ThemeProvider initial="dark">
        <ConnectDialog onSubmit={onSubmit} onCancel={() => {}} />
      </ThemeProvider>
    ),
    { width: 70, height: 10 },
  );
}

test("粘贴 Base URL 到当前字段", async () => {
  const setup = await renderDialog(() => {});
  try {
    await setup.renderOnce();
    await setup.mockInput.pasteBracketedText("https://api.example.com/v1");
    await setup.waitForFrame((frame) => frame.includes("https://api.example.com/v1"));
    expect(setup.captureCharFrame()).toContain("https://api.example.com/v1");
  } finally {
    setup.renderer.destroy();
  }
});

test("切到 Key 字段后可整段粘贴长随机密钥", async () => {
  let submitted: { url: string; key: string } | undefined;
  const setup = await renderDialog((url, key) => { submitted = { url, key }; });
  try {
    await setup.renderOnce();
    await setup.mockInput.pasteBracketedText("https://api.example.com/v1");
    await setup.waitForFrame((frame) => frame.includes("https://api.example.com/v1"));
    setup.mockInput.pressTab();
    const longKey = "sk-a1B2c3D4-e5F6g7H8-i9J0k1L2-m3N4o5P6q7R8";
    await setup.mockInput.pasteBracketedText(longKey);
    await setup.waitForFrame((frame) => frame.includes("*".repeat(longKey.length)));
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(submitted).toEqual({ url: "https://api.example.com/v1", key: longKey });
  } finally {
    setup.renderer.destroy();
  }
});

test("粘贴内容中的换行与转义序列被清理", async () => {
  let submitted: { url: string; key: string } | undefined;
  const setup = await renderDialog((url, key) => { submitted = { url, key }; });
  try {
    await setup.renderOnce();
    await setup.mockInput.pasteBracketedText("https://api.example.com/v1");
    await setup.waitForFrame((frame) => frame.includes("https://api.example.com/v1"));
    setup.mockInput.pressTab();
    await setup.mockInput.pasteBracketedText("abc\nxyz");
    await setup.waitForFrame((frame) => frame.includes("******"));
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(submitted?.key).toBe("abcxyz");
  } finally {
    setup.renderer.destroy();
  }
});
