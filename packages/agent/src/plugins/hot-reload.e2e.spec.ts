import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "@zeta-agent/framework";
import {
  buildWithBun,
  createPluginHotReloader,
  evaluateWithBun,
  type HotReloadUnit,
} from "./hot-reload";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-hmr-e2e-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function harness(dir: string, units: readonly HotReloadUnit[]) {
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  let evaluations = 0;
  const reloader = createPluginHotReloader({
    ctx: createContext({ uid: `e2e:${dir}` }),
    units,
    readFile,
    build: buildWithBun,
    evaluate: (artifact) => {
      evaluations += 1;
      return evaluateWithBun(artifact);
    },
  });
  return { reloader, get evaluations() { return evaluations; } };
}

describe("T-15 真实插件文件变更 HMR E2E", () => {
  test("文件改动不重启生效，未变 digest 不求值，共享依赖连通，失败保留旧导出", async () => {
    const dir = tempDir();
    const pluginFile = join(dir, "plugin.ts");
    const sharedFile = join(dir, "shared.ts");
    const otherFile = join(dir, "other.ts");
    writeFileSync(
      sharedFile,
      'export const tag = "v1";\n'
    );
    writeFileSync(
      pluginFile,
      `import { tag } from "./shared";\nexport default { name: "plugin", version: 1, tag };\n`
    );
    writeFileSync(otherFile, 'export default { name: "other", version: 1 };\n');

    const units: readonly HotReloadUnit[] = [
      { id: "plugin", entry: pluginFile },
      { id: "other", entry: otherFile },
    ];
    const harnessResult = harness(dir, units);
    const { reloader } = harnessResult;
    await reloader.install(units);
    expect(asRecord(reloader.valueOf("plugin")).version).toBe(1);
    expect(asRecord(reloader.valueOf("plugin")).tag).toBe("v1");
    expect(harnessResult.evaluations).toBe(2);

    // 真实文件改动：仅目标 unit 求值，不重启进程即可生效。
    writeFileSync(
      pluginFile,
      `import { tag } from "./shared";\nexport default { name: "plugin", version: 2, tag };\n`
    );
    reloader.markDirty([pluginFile]);
    const changed = await reloader.flush();
    expect(changed.settled).toEqual(["plugin"]);
    expect(asRecord(reloader.valueOf("plugin")).version).toBe(2);
    expect(harnessResult.evaluations).toBe(3);

    // 未变 digest：重新落脏但不求值。
    reloader.markDirty([pluginFile]);
    const reused = await reloader.flush();
    expect(reused.reused).toEqual(["plugin"]);
    expect(harnessResult.evaluations).toBe(3);

    // 共享依赖变更：连通 unit 同事务求值，其他 unit 不受影响。
    writeFileSync(sharedFile, 'export const tag = "v2";\n');
    reloader.markDirty([sharedFile]);
    const shared = await reloader.flush();
    expect(shared.settled).toEqual(["plugin"]);
    expect(asRecord(reloader.valueOf("plugin")).tag).toBe("v2");
    expect(asRecord(reloader.valueOf("other")).version).toBe(1);

    // 故障注入：语法错误保留旧导出（closure rule）。
    const good = reloader.valueOf("plugin");
    writeFileSync(pluginFile, "export default { broken\n");
    reloader.markDirty([pluginFile]);
    const failed = await reloader.flush();
    expect(failed.aborted).toEqual(["plugin"]);
    expect(reloader.valueOf("plugin")).toBe(good);
    expect(reloader.failed()).toEqual(["plugin"]);

    // 恢复源码后下次变更重试成功。
    writeFileSync(
      pluginFile,
      `import { tag } from "./shared";\nexport default { name: "plugin", version: 3, tag };\n`
    );
    reloader.markDirty([pluginFile]);
    const recovered = await reloader.flush();
    expect(recovered.retried).toEqual(["plugin"]);
    expect(asRecord(reloader.valueOf("plugin")).version).toBe(3);
    await reloader.close();
  });
});
