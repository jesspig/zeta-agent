import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionLoader } from "./loader";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-ext-loader-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("T-13 扩展加载器（动态 import + TS 原生支持）", () => {
  test("load 从临时目录加载 TS 扩展文件，generation 递增", async () => {
    const dir = tempDir();
    const file = join(dir, "banner.ts");
    writeFileSync(file, 'export default { name: "banner", version: 1 };\n');

    const loader = createExtensionLoader();
    const result = await loader.load([file]);

    expect(result.failures).toHaveLength(0);
    expect(result.generation).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(asRecord(result.entries[0]?.exports.default).name).toBe("banner");
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(1);
  });

  test("reload 重新求值变更文件，不重启进程即可拿到新导出", async () => {
    const dir = tempDir();
    const file = join(dir, "banner.ts");
    writeFileSync(file, 'export default { name: "banner", version: 1 };\n');

    const loader = createExtensionLoader();
    await loader.load([file]);
    writeFileSync(file, 'export default { name: "banner", version: 2 };\n');
    const result = await loader.reload();

    expect(result.generation).toBe(2);
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(2);
  });

  test("reload 遇到语法错误：记录失败并保留上一版导出（closure rule）", async () => {
    const dir = tempDir();
    const file = join(dir, "banner.ts");
    writeFileSync(file, 'export default { name: "banner", version: 1 };\n');

    const loader = createExtensionLoader();
    await loader.load([file]);
    writeFileSync(file, "export default { broken\n");
    const result = await loader.reload();

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe(file);
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(1);
  });

  test("reload 在未加载过时安全返回空结果", async () => {
    const loader = createExtensionLoader();
    const result = await loader.reload();
    expect(result.entries).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.generation).toBe(0);
  });
});
