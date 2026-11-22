import { describe, expect, test } from "bun:test";
import { createProviderStreamFn } from "./dispatch";

/** CR-26：静态别名解析必须限定在所选 provider 内，不能跨provider取模型名。 */
describe("T-25 Provider 模型归属校验", () => {
  test("拒绝其它 provider 的专属别名", () => {
    expect(() =>
      createProviderStreamFn({ provider: "groq", model: "sonnet", apiKey: "k" })
    ).toThrow(/UNKNOWN_MODEL/);
  });

  test("接受本 provider 的别名", () => {
    expect(() =>
      createProviderStreamFn({ provider: "groq", model: "llama", apiKey: "k" })
    ).not.toThrow();
  });
});
