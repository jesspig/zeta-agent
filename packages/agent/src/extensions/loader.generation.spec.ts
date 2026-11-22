import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionLoader } from "./loader";

/** CR-24：并发重载时较旧操作不得覆盖较新快照。 */
describe("T-23 扩展加载代次提交", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("并发 load 后 entries 的 generation 与当前 generation 一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-ext-gen-"));
    dirs.push(dir);
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, 'export default { name: "a" };\n');
    writeFileSync(b, 'export default { name: "b" };\n');
    const loader = createExtensionLoader();
    await Promise.all([loader.load([a]), loader.load([b])]);
    expect(loader.generation).toBe(2);
    // 最终快照必须与最新代次一致（不会是旧的 a）
    const entries = (await loader.reload()).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]?.generation).toBe(loader.generation);
  });
});
