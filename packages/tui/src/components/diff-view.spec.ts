import { describe, expect, test } from "bun:test";
import { diffLines, diffWords } from "./diff-view";

describe("U-06 词级 diff（真正 LCS）", () => {
  test("单词替换：精确找出删除/新增词，而非字符窗口", () => {
    const result = diffWords("the quick fox", "the slow fox");
    expect(result.removedWords).toEqual(["quick"]);
    expect(result.addedWords).toEqual(["slow"]);
  });

  test("纯插入：无删除词", () => {
    const result = diffWords("hello world", "hello brave world");
    expect(result.removedWords).toEqual([]);
    expect(result.addedWords).toEqual(["brave"]);
  });

  test("纯删除：无新增词", () => {
    const result = diffWords("hello brave world", "hello world");
    expect(result.removedWords).toEqual(["brave"]);
    expect(result.addedWords).toEqual([]);
  });

  test("多词改写：逐词 LCS 不受位置偏移影响", () => {
    const result = diffWords("alpha beta gamma", "alpha delta gamma epsilon");
    expect(result.removedWords).toEqual(["beta"]);
    expect(result.addedWords).toEqual(["delta", "epsilon"]);
  });

  test("行级 diff 携带词级明细", () => {
    const lines = diffLines("the quick fox\nshared", "the slow fox\nshared");
    const changed = lines.find((line) => line.wordDiff?.kind === "replace");
    expect(changed?.wordDiff?.removedWords).toEqual(["quick"]);
    expect(changed?.wordDiff?.addedWords).toEqual(["slow"]);
  });
});
