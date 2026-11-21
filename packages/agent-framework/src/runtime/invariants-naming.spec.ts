import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(pkgRoot, "../..");

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

/**
 * AC-04 / T-04：两组 12 条不变量在文档与测试命名上明确区分。
 * - agent-core 12 条：runtime/invariants.spec.ts，inv-core- 前缀。
 * - 工具流水线 12 条：tools/invariants.spec.ts，inv-tool- 前缀。
 */
describe("T-04 不变量命名区分与 A6 对齐", () => {
  test("inv-core- 前缀存在于 agent-core 测试", () => {
    const src = read("packages/agent-framework/src/runtime/invariants.spec.ts");
    expect(src).toContain("inv-core-");
  });

  test("inv-tool- 前缀存在于工具流水线测试", () => {
    const src = read("packages/agent-framework/src/tools/invariants.spec.ts");
    expect(src).toContain("inv-tool-");
  });

  test("roadmap A6 明确 agent-core 与工具流水线两组", () => {
    const doc = read("docs/desgin/delivery/roadmap.md");
    const a6 = doc.split("\n").find((line) => line.includes("| A6 |"));
    expect(a6).toBeDefined();
    expect(a6).toContain("agent-core");
    expect(a6).toContain("工具流水线");
  });

  test("state-and-events §13 区分两组并含命名前缀", () => {
    const doc = read("docs/desgin/agent-framework/state-and-events.md");
    expect(doc).toContain("inv-core-");
    expect(doc).toContain("inv-tool-");
  });
});
