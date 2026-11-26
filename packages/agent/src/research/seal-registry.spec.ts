import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilePromotionSealRegistry, promotionSealKey } from "./seal-registry";

describe("T-22 晋升 seal 跨进程持久化注册表", () => {
  test("写入后新建实例仍可识别同一 seal 键", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-seal-registry-"));
    const file = join(dir, "seals.json");
    try {
      const key = promotionSealKey("identity-1", "cand-1", 0.9);
      createFilePromotionSealRegistry(file).record(key);
      const reopened = createFilePromotionSealRegistry(file);
      expect(reopened.has(key)).toBe(true);
      expect(reopened.has(promotionSealKey("identity-1", "cand-1", 0.8))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("损坏注册表失败关闭", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-seal-registry-bad-"));
    const file = join(dir, "seals.json");
    try {
      writeFileSync(file, JSON.stringify({ schemaVersion: 2, keys: [] }), "utf8");
      expect(() => createFilePromotionSealRegistry(file)).toThrow("INVALID_PROMOTION_SEAL_REGISTRY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
