import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const probe = resolve(here, "__fixtures__/tui-import-probe.ts");

test("interactive 路径先加载 OpenTUI preload 再动态导入 TUI", () => {
  const result = spawnSync(process.execPath, [probe], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000,
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stdout.trim()).toBe("TUI_IMPORT_OK");
  expect(result.stderr).not.toContain("getContextId");
}, 30_000);
