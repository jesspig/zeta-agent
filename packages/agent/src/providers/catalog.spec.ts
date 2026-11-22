import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CATALOG_VERSION, MODELS, PROVIDERS } from "./catalog.generated";
import { createModelRegistry } from "./registry";

interface SourceModel {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly input: readonly string[];
  readonly api: string;
}

interface SourceData {
  readonly version: number;
  readonly providers: readonly { readonly id: string; readonly name: string; readonly defaultBaseUrl: string; readonly api: string }[];
  readonly models: readonly SourceModel[];
}

const source = JSON.parse(
  readFileSync(new URL("./catalog.source.json", import.meta.url), "utf8")
) as SourceData;

describe("模型 catalog（T-12）", () => {
  test("生成文件与源数据一致（禁止手改生成文件）", () => {
    expect(CATALOG_VERSION as number).toBe(source.version);
    expect(MODELS.length).toBe(source.models.length);
    expect(PROVIDERS.length).toBe(source.providers.length);
    for (const model of source.models) {
      const generated = MODELS.find((entry) => entry.id === model.id);
      expect(generated).toBeDefined();
      expect(generated?.provider).toBe(model.provider);
      expect(generated?.name).toBe(model.name);
      expect([...(generated?.aliases ?? [])]).toEqual([...model.aliases]);
      expect(generated?.contextWindow).toBe(model.contextWindow);
      expect(generated?.maxOutput).toBe(model.maxOutput);
      expect([...(generated?.input ?? [])]).toEqual([...model.input]);
      expect(generated?.api).toBe(model.api);
    }
  });

  test("覆盖全部主流 provider", () => {
    const ids = new Set(PROVIDERS.map((provider) => provider.id));
    for (const expected of ["openai", "openai-responses", "anthropic", "google", "bedrock", "openrouter", "groq", "deepseek"]) {
      expect(ids.has(expected)).toBe(true);
    }
    expect(MODELS.length).toBeGreaterThanOrEqual(16);
  });

  test("按完整 id 解析模型", () => {
    const registry = createModelRegistry();
    expect(registry.resolve("openai/gpt-4o")?.name).toBe("gpt-4o");
    expect(registry.resolve("anthropic/claude-sonnet-4-5")?.provider).toBe("anthropic");
    expect(registry.resolve("google/gemini-2.5-pro")?.api).toBe("google-generate");
  });

  test("按别名解析模型", () => {
    const registry = createModelRegistry();
    expect(registry.resolve("sonnet")?.id).toBe("anthropic/claude-sonnet-4-5");
    expect(registry.resolve("gpt-4o-mini")?.id).toBe("openai/gpt-4o-mini");
    expect(registry.resolve("r1")?.id).toBe("deepseek/deepseek-reasoner");
  });

  test("按 provider 侧模型名解析（无歧义时）", () => {
    const registry = createModelRegistry();
    expect(registry.resolve("gemini-2.5-flash")?.id).toBe("google/gemini-2.5-flash");
  });

  test("未知引用返回 undefined", () => {
    const registry = createModelRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
    expect(registry.resolve("")).toBeUndefined();
  });

  test("list 按 provider 过滤", () => {
    const registry = createModelRegistry();
    const openai = registry.list({ provider: "openai" });
    expect(openai.length).toBeGreaterThan(0);
    for (const model of openai) expect(model.provider).toBe("openai");
  });

  test("重复别名不覆盖首个注册项", () => {
    const registry = createModelRegistry([
      { id: "p/a", provider: "openai", name: "a", aliases: ["x"], contextWindow: 1, maxOutput: 1, input: ["text"], api: "openai-chat" },
      { id: "p/b", provider: "groq", name: "b", aliases: ["x"], contextWindow: 1, maxOutput: 1, input: ["text"], api: "openai-chat" },
    ]);
    expect(registry.resolve("x")?.id).toBe("p/a");
    expect(registry.duplicateAliases).toContain("x");
  });
});
