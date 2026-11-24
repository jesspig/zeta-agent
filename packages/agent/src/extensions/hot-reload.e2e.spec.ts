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

/**
 * T-06：evaluation 失败时 data URL 内容寻址 + `Fiber.reload` 复用 identity 的等价路径，
 * 必须保留旧导出与宿主会话（对应 cordis 的"按 unit 恢复旧实例 / FAILED 留待重试"）。
 * Node 内部缓存驱逐 API 在 Bun 不可达，故以导出对象引用不变作为会话保留证据。
 */
describe("T-06 e2e reload 保留会话与旧导出", () => {
  test("语法错误 reload 保留旧导出对象引用与会话状态，恢复后重试成功", async () => {
    const dir = tempDir();
    const file = join(dir, "session.ts");
    writeFileSync(
      file,
      'export default { name: "session", version: 1, session: { count: 0 } };\n'
    );

    const loader = createExtensionLoader();
    const first = await loader.load([file]);
    expect(first.failures).toHaveLength(0);
    expect(asRecord(first.entries[0]?.exports.default).version).toBe(1);

    // reload 到 v2，拿到新导出，并在其上累积宿主会话状态。
    writeFileSync(
      file,
      'export default { name: "session", version: 2, session: { count: 0 } };\n'
    );
    const second = await loader.reload();
    const v2 = asRecord(second.entries[0]?.exports.default);
    expect(v2.version).toBe(2);
    (asRecord(v2.session) as Record<string, unknown>).count = 42;

    // 语法错误：reload 记录失败，但导出仍是同一个 v2 对象（旧导出未破坏，会话不丢失）。
    writeFileSync(file, "export default { broken\n");
    const failed = await loader.reload();
    expect(failed.failures).toHaveLength(1);
    const afterFail = failed.entries[0]?.exports.default;
    expect(afterFail).toBe(v2);
    expect(asRecord(asRecord(afterFail).session)).toBe(asRecord(v2.session));
    expect(asRecord(asRecord(afterFail).session).count).toBe(42);

    // 恢复源码后重试成功，失败单元被重新拉起。
    writeFileSync(
      file,
      'export default { name: "session", version: 3, session: { count: 0 } };\n'
    );
    const third = await loader.reload();
    expect(third.failures).toHaveLength(0);
    expect(asRecord(third.entries[0]?.exports.default).version).toBe(3);
  });
});
