import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionLoader, type LoadResult } from "./loader";
import { resolveReplaceable, type Replaceable } from "./replaceable";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-ext-e2e-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("T-13 扩展加载端到端", () => {
  test("写扩展 TS → 加载 → 修改文件 → reload 生效 → 语法错误回退 → replaceable 接管", async () => {
    const dir = tempDir();
    const builtinFile = join(dir, "banner.ts");
    writeFileSync(
      builtinFile,
      'export default { name: "banner", version: 1, kind: "builtin" };\n',
    );

    const loader = createExtensionLoader();
    let result: LoadResult = await loader.load([builtinFile]);
    expect(result.failures).toHaveLength(0);
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(1);

    // 修改扩展源码，无需重启进程即可拿到新版本。
    writeFileSync(
      builtinFile,
      'export default { name: "banner", version: 2, kind: "builtin" };\n',
    );
    result = await loader.reload();
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(2);

    // 故障注入：语法错误时 reload 记录失败并保留上一版导出。
    writeFileSync(builtinFile, "export default { broken\n");
    result = await loader.reload();
    expect(result.failures).toHaveLength(1);
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(2);

    // 恢复源码后重试成功，失败单元被重新拉起。
    writeFileSync(
      builtinFile,
      'export default { name: "banner", version: 3, kind: "builtin" };\n',
    );
    result = await loader.reload();
    expect(result.failures).toHaveLength(0);
    expect(asRecord(result.entries[0]?.exports.default).version).toBe(3);

    // replaceable 解析：第三方扩展按 name 整包接管内置项。
    const builtins: Replaceable<string>[] = [
      { name: "banner", replaceable: true, value: "builtin:v3" },
      { name: "core", replaceable: false, value: "builtin:core" },
    ];
    const extras: Replaceable<string>[] = [
      { name: "banner", replaceable: true, value: "third:v3" },
    ];
    const resolved = resolveReplaceable(builtins, extras);
    expect(resolved.active).toEqual(["third:v3", "builtin:core"]);
    expect(resolved.replaced).toEqual(["banner"]);
  });
});
