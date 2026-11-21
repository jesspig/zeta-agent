import { describe, expect, test } from "bun:test";
import {
  createCompletion,
  fuzzyScore,
  type CompletionProvider,
  type CompletionResult,
} from "./completion";
import { createCommandPalette } from "./command-palette";

describe("T-09 补全与命令面板（IF-09）", () => {
  test("文件路径补全：按前缀返回候选", () => {
    const completion = createCompletion({
      file: {
        complete: (prefix) =>
          Promise.resolve(["src/index.ts", "src/app.ts", "docs/readme.md"].filter((p) => p.startsWith(prefix))),
      },
    });
    const result = completion.complete("src/", "file");
    return result.then((value: CompletionResult) => {
      expect(value.items).toContain("src/index.ts");
      expect(value.items).not.toContain("docs/readme.md");
    });
  });

  test("slash 命令与 provider 补全来源", () => {
    const completion = createCompletion({
      slash: { complete: (prefix) => Promise.resolve(["/help", "/clear", "/model"].filter((s) => s.startsWith(prefix))) },
      provider: { complete: () => Promise.resolve(["openai", "anthropic"]) },
    });
    return Promise.all([
      completion.complete("/he", "slash"),
      completion.complete("", "provider"),
    ]).then(([slash, provider]) => {
      expect(slash.items).toEqual(["/help"]);
      expect(provider.items).toEqual(["openai", "anthropic"]);
    });
  });

  test("模糊匹配按分数排序", () => {
    expect(fuzzyScore("abc", "abc")).toBeGreaterThan(fuzzyScore("abc", "axc"));
    const ranked = ["axc", "abc", "a-b-c"].sort((a, b) => fuzzyScore("abc", b) - fuzzyScore("abc", a));
    expect(ranked[0]).toBe("abc");
  });

  test("异步陈旧结果被丢弃（generation 守卫）", async () => {
    let resolveFirst!: (value: string[]) => void;
    let resolveSecond!: (value: string[]) => void;
    let call = 0;
    const slowProvider: CompletionProvider = {
      complete: () =>
        new Promise<string[]>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    };
    const completion = createCompletion({ slow: slowProvider });

    const first = completion.complete("a", "slow");
    const second = completion.complete("ab", "slow");
    resolveSecond(["fresh"]);
    const fresh = await second;
    expect(fresh.items).toEqual(["fresh"]);
    resolveFirst(["stale"]);
    const stale = await first;
    expect(stale.items).toEqual([]);
    expect(stale.stale).toBe(true);
  });

  test("命令面板过滤与选中", () => {
    const palette = createCommandPalette([
      { id: "help", title: "帮助" },
      { id: "clear", title: "清屏" },
      { id: "model", title: "模型" },
    ]);
    const filtered = palette.filter("清");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("clear");
    expect(palette.select("model")?.title).toBe("模型");
  });
});
