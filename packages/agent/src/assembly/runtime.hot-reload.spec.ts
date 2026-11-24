import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRuntime } from "./runtime";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_FOR_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-runtime-hmr-"));
  dirs.push(dir);
  return dir;
}

describe("T-15 默认装配接入插件 HMR", () => {
  test("hotReloadDirs 装配真实 file watcher 并随 runtime dispose 撤销", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "plugin.ts"), 'export default { name: "plugin", version: 1 };\n');

    const runtime = await createDefaultRuntime({ includeBuiltins: false, hotReloadDirs: [dir] });
    expect(runtime.hotReload).toBeDefined();
    const fiber = runtime.hotReload?.fiberOf("plugin.ts");
    expect(fiber).toBeDefined();
    const installedFiber = fiber;
    expect(fiber?.state.kind).toBe("ACTIVE");
    expect(runtime.hotReload?.revisionOf("plugin.ts")).toBe(1);

    await runtime.dispose();
    expect(installedFiber?.state.kind).toBe("DISPOSED");
  });

  test("真实文件变更经自动 watcher 不重启生效，其他 unit 状态保留", async () => {
    const dir = tempDir();
    const changed = join(dir, "plugin.ts");
    const untouched = join(dir, "stable.ts");
    writeFileSync(changed, 'export default { name: "plugin", version: 1 };\n');
    writeFileSync(untouched, 'export default { name: "stable", version: 1 };\n');

    const runtime = await createDefaultRuntime({ includeBuiltins: false, hotReloadDirs: [dir] });
    const hotReload = runtime.hotReload!;
    const before = asRecord(hotReload.valueOf("plugin.ts"));
    const untouchedFiber = hotReload.fiberOf("stable.ts");
    expect(before.version).toBe(1);

    writeFileSync(changed, 'export default { name: "plugin", version: 2 };\n');
    await waitFor(() => asRecord(hotReload.valueOf("plugin.ts")).version === 2);

    expect(hotReload.revisionOf("plugin.ts")).toBe(2);
    expect(hotReload.revisionOf("stable.ts")).toBe(1);
    expect(hotReload.fiberOf("plugin.ts")?.state.kind).toBe("ACTIVE");
    expect(hotReload.fiberOf("stable.ts")).toBe(untouchedFiber);
    await runtime.dispose();
  });
});
