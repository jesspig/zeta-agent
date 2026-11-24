import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

/**
 * 真实运行路径（非 bun test）必须加载 @opentui/solid/preload：
 * solid-js 在 bun 的 node 条件下默认解析到 server.js，只有 preload 注册的
 * Bun 插件会把 server.js 重写回客户端 solid.js。回归此前的启动崩溃。
 */
test("plain bun 运行路径解析到 solid-js 客户端构建（preload 生效）", () => {
  const probe = resolve(here, "__fixtures__/solid-build-probe.ts");
  const result = spawnSync(process.execPath, ["--preload", "@opentui/solid/preload", probe], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("CLIENT");
});

test("plain bun 运行路径可渲染真实 TUI 组件（无 server build 崩溃）", () => {
  const entry = resolve(here, "__fixtures__/runtime-preload-probe.tsx");
  const result = spawnSync(process.execPath, ["--preload", "@opentui/solid/preload", entry], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("RENDER_OK");
  expect(result.stdout).not.toContain("getContextId");
  expect(result.stdout).not.toContain("Orphan text");
});
