import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync, type AtomicWriteStage } from "./atomic-file";

function tempPath(): { file: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zeta-atomic-file-"));
  return { file: join(dir, "journal.json"), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("T-14 原子文件写入（短写 / ENOSPC / 中断）", () => {
  test("短写循环仍写出完整内容；fsync 先于 rename，rename 前目标保持旧内容", () => {
    const { file, cleanup } = tempPath();
    try {
      writeFileSync(file, "old", "utf8");
      const order: AtomicWriteStage[] = [];
      const beforeRename = readFileSync(file, "utf8");
      atomicWriteFileSync(file, "x".repeat(4096), {
        maxWriteChunk: 7,
        hook: (stage) => {
          order.push(stage);
          if (stage === "before-rename") expect(readFileSync(file, "utf8")).toBe(beforeRename);
        },
      });
      expect(readFileSync(file, "utf8")).toBe("x".repeat(4096));
      expect(order.indexOf("temp-synced")).toBeLessThan(order.indexOf("before-rename"));
      expect(order.indexOf("before-rename")).toBeLessThan(order.indexOf("renamed"));
      expect(order.indexOf("renamed")).toBeLessThan(order.indexOf("complete"));
    } finally {
      cleanup();
    }
  });

  for (const stage of ["temp-opened", "temp-writing", "temp-synced", "before-rename"] as const) {
    test(`${stage} 阶段中断：目标仍是完整旧内容，临时文件被清理`, () => {
      const { file, dir, cleanup } = tempPath();
      try {
        writeFileSync(file, "old", "utf8");
        expect(() =>
          atomicWriteFileSync(file, "new".repeat(1024), {
            maxWriteChunk: 64,
            hook: (current) => {
              if (current === stage) throw new Error("INJECTED_ENOSPC");
            },
          })
        ).toThrow("INJECTED_ENOSPC");
        expect(readFileSync(file, "utf8")).toBe("old");
        expect(readdirSync(dir).filter((name) => name.startsWith(".zeta-tmp-"))).toEqual([]);
      } finally {
        cleanup();
      }
    });
  }

  test("首次写入前中断：目标文件不存在，不留下半写快照", () => {
    const { file, dir, cleanup } = tempPath();
    try {
      expect(() =>
        atomicWriteFileSync(file, "{}", {
          hook: (stage) => {
            if (stage === "temp-writing") throw new Error("INJECTED_INTERRUPT");
          },
        })
      ).toThrow("INJECTED_INTERRUPT");
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith(".zeta-tmp-"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("rename 后中断不回滚已提交的新内容", () => {
    const { file, cleanup } = tempPath();
    try {
      expect(() =>
        atomicWriteFileSync(file, "new", {
          hook: (stage) => {
            if (stage === "renamed") throw new Error("INJECTED_AFTER_COMMIT");
          },
        })
      ).toThrow("INJECTED_AFTER_COMMIT");
      expect(readFileSync(file, "utf8")).toBe("new");
    } finally {
      cleanup();
    }
  });
});
