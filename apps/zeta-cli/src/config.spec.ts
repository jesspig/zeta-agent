import { describe, expect, test } from "bun:test";
import { resolveModelConfig } from "./config";

describe("模型配置读取", () => {
  test("环境变量齐全时返回配置", () => {
    const config = resolveModelConfig({
      ZETA_BASE_URL: "https://api.test/v1",
      ZETA_API_KEY: "k-123",
      ZETA_MODEL: "model-x",
    });
    expect(config).toEqual({
      baseUrl: "https://api.test/v1",
      apiKey: "k-123",
      model: "model-x",
    });
  });

  test("缺少任一必需变量返回 null（回退 echo）", () => {
    expect(resolveModelConfig({ ZETA_BASE_URL: "x", ZETA_MODEL: "m" })).toBeNull();
    expect(resolveModelConfig({})).toBeNull();
  });

  test("去除 baseUrl 尾部斜杠", () => {
    const config = resolveModelConfig({
      ZETA_BASE_URL: "https://api.test/v1/",
      ZETA_API_KEY: "k",
      ZETA_MODEL: "m",
    });
    expect(config?.baseUrl).toBe("https://api.test/v1");
  });
});
