import { describe, expect, test } from "bun:test";
import { resolveModelConfig, type ConfigResolution } from "./config";

const FULL_ENV = {
  ZETA_BASE_URL: "https://api.test/v1",
  ZETA_API_KEY: "k-123",
  ZETA_MODEL: "model-x",
};

describe("模型配置读取", () => {
  test("环境变量齐全时返回 configured", () => {
    const resolution = resolveModelConfig(FULL_ENV);
    expect(resolution.kind).toBe("configured");
    if (resolution.kind === "configured") {
      expect(resolution.config).toEqual({
        baseUrl: "https://api.test/v1",
        apiKey: "k-123",
        model: "model-x",
      });
    }
  });

  test("缺少任一必需变量返回 fallback 并列出缺失变量名", () => {
    const missingKey = resolveModelConfig({ ZETA_BASE_URL: "x", ZETA_MODEL: "m" });
    expect(missingKey.kind).toBe("fallback");
    if (missingKey.kind === "fallback") {
      expect(missingKey.missing).toEqual(["ZETA_API_KEY"]);
    }
    const missingAll = resolveModelConfig({});
    expect(missingAll.kind).toBe("fallback");
    if (missingAll.kind === "fallback") {
      expect(missingAll.missing).toEqual(["ZETA_BASE_URL", "ZETA_API_KEY", "ZETA_MODEL"]);
    }
  });

  test("去除 baseUrl 尾部斜杠", () => {
    const resolution = resolveModelConfig({ ...FULL_ENV, ZETA_BASE_URL: "https://api.test/v1/" });
    expect(resolution.kind).toBe("configured");
    if (resolution.kind === "configured") {
      expect(resolution.config.baseUrl).toBe("https://api.test/v1");
    }
  });

  test("空白字符串视为缺失", () => {
    const resolution = resolveModelConfig({ ...FULL_ENV, ZETA_API_KEY: "   " });
    expect(resolution.kind).toBe("fallback");
    if (resolution.kind === "fallback") {
      expect(resolution.missing).toEqual(["ZETA_API_KEY"]);
    }
  });
});
