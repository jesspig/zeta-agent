import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "./hmr";

/** CR-34：同一防抖窗口内多个文件变更都要登记为脏。 */
describe("T-34 自动 watcher 脏路径登记", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("同窗口两个文件变更都进入事务", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-hmr-auto-"));
    dirs.push(root);
    writeFileSync(join(root, "a.ts"), "a");
    writeFileSync(join(root, "b.ts"), "b");
    const watcher = watch(root, {
      units: [{ id: "a", file: "a.ts" }, { id: "b", file: "b.ts" }],
      build: (unitRef, version) => ({ id: `${unitRef.id}?v=${version}`, version }),
      evaluate: (artifact) => ({ artifact: artifact.id, value: artifact.version }),
      apply: () => {},
      auto: true,
      debounceMs: 60,
    });
    writeFileSync(join(root, "a.ts"), "a2");
    writeFileSync(join(root, "b.ts"), "b2");
    await new Promise((r) => setTimeout(r, 250));
    await watcher.flush();
    const bothBuilt = watcher.stateOf("a") !== undefined && watcher.stateOf("b") !== undefined;
    expect(bothBuilt).toBe(true);
    watcher.close();
  });
});
