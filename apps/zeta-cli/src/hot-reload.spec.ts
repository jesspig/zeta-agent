import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRuntime } from "./index";
import { parseArgs } from "./args";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("T-15 CLI 插件 HMR 接线", () => {
  test("--watch 解析为 watchDirs 并驱动统一 loader 装配", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-cli-hmr-"));
    dirs.push(dir);
    writeFileSync(join(dir, "plugin.ts"), 'export default { name: "plugin", version: 1 };\n');

    const args = parseArgs(["--headless", "--watch", dir, "hello"]);
    expect(args.watchDirs).toEqual([dir]);

    const bundle = await makeRuntime(args);
    expect(bundle.runtime.hotReload).toBeDefined();
    const fiber = bundle.runtime.hotReload?.fiberOf("plugin.ts");
    expect(fiber).toBeDefined();
    expect(fiber?.state.kind).toBe("ACTIVE");
    await bundle.runtime.dispose();
  });
});
