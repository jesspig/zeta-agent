import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRegistry } from "../commands/registry";
import { createSessionTree } from "./tree";
import { registerSessionCommands } from "./tree-commands";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-session-cmd-"));
  dirs.push(dir);
  return join(dir, "session.jsonl");
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("T-16 会话树与 /session /tree 命令联动", () => {
  test("/session 报告当前会话状态，/tree 输出活跃分支", async () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "hello" });
    const outputs: string[] = [];
    const registry = createCommandRegistry();
    registerSessionCommands(registry, tree, (line) => outputs.push(line));

    const session = await registry.execute("/session");
    const branch = await registry.execute("/tree");

    expect(session.ok).toBe(true);
    expect(branch.ok).toBe(true);
    expect(outputs.join("\n")).toContain("hello");
  });

  test("/new 新建分支，/fork 从当前分支分叉，leaf 变化", async () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "base" });
    const before = tree.leaf();
    const registry = createCommandRegistry();
    registerSessionCommands(registry, tree, () => {});

    const forked = await registry.execute("/fork");
    expect(forked.ok).toBe(true);
    expect(tree.leaf()).not.toBe(before);
  });
});
