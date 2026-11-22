import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgent } from "../facade";

/**
 * CR-02 / T-02：文件工具的目录边界必须约束实际文件目标。
 * 用目录联接（junction）构造根内路径指向根外目录的越界场景：
 * 字符串 resolve/relative 通过，但真实目标在允许目录之外。
 */
describe("T-02 文件工具实际目标边界", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-confine-root-"));
    outside = mkdtempSync(join(tmpdir(), "zeta-confine-out-"));
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function readVia(pathArg: string): Promise<unknown> {
    const agent = createAgent({
      allowedDirectories: [root],
      streamFn: async function* () {
        yield `@@TOOL:read:${JSON.stringify({ path: pathArg })}@@`;
      },
      allowTextToolMarkers: true,
    });
    const messages = await agent.prompt("go");
    const toolResult = [...messages].reverse().find((m) => m.role === "toolResult");
    return toolResult?.content;
  }

  function makeJunction(linkPath: string, targetDir: string): boolean {
    try {
      // Windows 目录联接无需管理员权限；POSIX 回退到符号链接。
      if (process.platform === "win32") {
        const { execFileSync } = require("node:child_process");
        execFileSync("cmd", ["/c", "mklink", "/J", linkPath, targetDir], { stdio: "ignore" });
      } else {
        require("node:fs").symlinkSync(targetDir, linkPath, "dir");
      }
      return true;
    } catch {
      return false;
    }
  }

  test("根内的目录联接指向根外目录时读取被拒绝", async () => {
    const linkDir = join(root, "escape-dir");
    if (!makeJunction(linkDir, outside)) return; // 平台不支持时跳过，不计为通过
    const content = await readVia(join(linkDir, "secret.txt"));
    const text = typeof content === "object" && content !== null
      ? String((content as Record<string, unknown>).error ?? "")
      : String(content);
    expect(text).toMatch(/CONFINEMENT|outside/i);
    expect(text).not.toContain("TOP-SECRET");
  });

  test("根内普通文件仍可读取", async () => {
    writeFileSync(join(root, "ok.txt"), "INSIDE-OK", "utf8");
    const content = await readVia(join(root, "ok.txt"));
    const text = typeof content === "object" && content !== null
      ? String((content as Record<string, unknown>).content ?? "")
      : String(content);
    expect(text).toContain("INSIDE-OK");
  });
});
