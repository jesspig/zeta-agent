import { describe, expect, test } from "bun:test";
import { diffWords, diffLines } from "./diff-view";

/** CR-30：超大编辑输入必须走有界路径，不分配无上限的 LCS 表。 */
describe("T-30 有界 diff 计算", () => {
  test("超大输入 diffWords 在预算内返回有界结果", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const start = Date.now();
    const result = diffWords(big, `${big} extra`);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.addedWords.length + result.removedWords.length).toBeLessThan(200);
  });

  test("超大输入 diffLines 在预算内返回有界结果", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const start = Date.now();
    const lines = diffLines(big, `${big}\nnew`);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(lines.length).toBeLessThan(100);
  });
});
