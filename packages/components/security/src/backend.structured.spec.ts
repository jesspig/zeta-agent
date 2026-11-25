import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLocalSafeBackend, type LocalSafeBackendOptions } from "./backend.local-safe";

/** T-09：结构化文件事务——validate-all、dry-run、单文件 capability、故障回滚。 */
describe("T-09 structured apply_patch", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-patch-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = (options: LocalSafeBackendOptions = {}) =>
    createLocalSafeBackend({ allowedDirectories: [root], ...options });

  test("validate-all：任一补丁校验失败则所有文件零变化", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    writeFileSync(a, "one", "utf8");
    writeFileSync(b, "two", "utf8");
    const backend = make();

    const result = await backend.file.applyPatch([
      { path: a, from: "one", to: "ONE" },
      { path: b, from: "MISSING", to: "X" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATCH_VALIDATION_FAILED");
    expect(readFileSync(a, "utf8")).toBe("one");
    expect(readFileSync(b, "utf8")).toBe("two");
  });

  test("dry-run 返回计划但不写入任何文件", async () => {
    const a = join(root, "a.txt");
    writeFileSync(a, "alpha", "utf8");
    const backend = make();

    const result = await backend.file.applyPatch(
      [{ path: a, from: "alpha", to: "ALPHA" }],
      { dryRun: true }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dryRun).toBe(true);
      expect(result.value.changes[0]?.replacements).toBe(1);
      expect(result.value.applied).toHaveLength(0);
    }
    expect(readFileSync(a, "utf8")).toBe("alpha");
  });

  test("多文件回滚：第 N 个写入失败时，前 N-1 个恢复原内容", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    writeFileSync(a, "first", "utf8");
    writeFileSync(b, "second", "utf8");
    const backend = make({
      failWrite: (path) => basename(path) === "b.txt",
    });

    const result = await backend.file.applyPatch([
      { path: a, from: "first", to: "FIRST" },
      { path: b, from: "second", to: "SECOND" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATCH_WRITE_FAILED");
    expect(readFileSync(a, "utf8")).toBe("first");
    expect(readFileSync(b, "utf8")).toBe("second");
  });

  test("单文件 capability：补丁声明不可用能力时 validate-all 拒绝且不写入", async () => {
    const a = join(root, "a.txt");
    writeFileSync(a, "keep", "utf8");
    const backend = make();

    const result = await backend.file.applyPatch([
      { path: a, from: "keep", to: "changed", capability: "shell.start" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OPERATION_UNAVAILABLE");
    expect(readFileSync(a, "utf8")).toBe("keep");
  });

  test("expected-stat 不匹配时拒绝写入并保留原内容（降低 TOCTOU）", async () => {
    const a = join(root, "a.txt");
    writeFileSync(a, "v1", "utf8");
    const backend = make();

    const result = await backend.file.write(a, "v2", { expected: { size: 999 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXPECTED_STAT_MISMATCH");
    expect(readFileSync(a, "utf8")).toBe("v1");
  });

  test("read/write 复用 fstat 快照，expected-stat 匹配时写入成功", async () => {
    const a = join(root, "a.txt");
    writeFileSync(a, "v1", "utf8");
    const stat = lstatSync(a);
    const backend = make();

    const result = await backend.file.write(a, "v2", {
      expected: { dev: stat.dev, ino: stat.ino, size: stat.size },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("v2");
  });

  test("非常规文件（目录/FIFO 同类）被句柄检查拒绝", async () => {
    const backend = make();
    const result = await backend.file.read(root); // 目录：非常规文件
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toMatch(/UNSUPPORTED_FILE_TYPE|FILE_OPERATION_FAILED/);
  });

  test("符号链接目标被 nofollow/reparse point 检查拒绝", async () => {
    if (process.platform === "win32") return; // POSIX 符号链接场景；Windows 由 junction 用例覆盖
    const { symlinkSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "zeta-outside-"));
    try {
      const secret = join(outside, "secret.txt");
      writeFileSync(secret, "TOP-SECRET", "utf8");
      const link = join(root, "link.txt");
      symlinkSync(secret, link);
      const backend = make();

      const result = await backend.file.read(link);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toMatch(/CONFINEMENT|NOFOLLOW|LINK/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
