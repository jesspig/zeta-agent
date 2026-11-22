import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createSessionTree } from "./tree";

/** CR-22：写盘失败不得推进内存中的 leaf、entries 与血缘。 */
describe("T-20 会话树原子发布", () => {
  test("persist 失败时内存状态不变", () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-tree-atomic-"));
    try {
      // 父目录不存在：初始化时 existsSync=false 不读文件，persist 的 writeFileSync 会失败
      const missingParent = join(root, "no-such-dir", "tree.jsonl");
      const tree = createSessionTree({ path: missingParent });
      const before = tree.entries().length;
      let threw = false;
      try {
        tree.append({ role: "user", content: "x" });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(tree.entries()).toHaveLength(before);
      expect(tree.leaf()).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
