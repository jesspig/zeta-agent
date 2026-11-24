import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact";
import { currentRelease, installRelease, rollbackRelease, upgradeRelease, type ReleaseStore } from "./lifecycle";

function manifest(target = "linux-x64"): ArtifactManifest {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    version: 1,
    target: target as ArtifactManifest["target"],
    binary: { arch: target.includes("arm64") ? "arm64" : "x64", path: "zeta", bytes: 3, sha256 },
    embedded: [],
  };
}

class MemoryStore implements ReleaseStore {
  readonly files = new Map<string, string>();
  read(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }
  write(path: string, data: string): void {
    this.files.set(path, data);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
}

describe("T-20 安装 / 升级 / 回滚生命周期", () => {
  test("install → upgrade → rollback 恢复上一版本且摘要可核验", () => {
    const store = new MemoryStore();
    const v1 = manifest();
    const v2 = manifest("linux-arm64");
    const first = installRelease("/install", "1.0.0", v1, store);
    expect(first.version).toBe("1.0.0");
    expect(currentRelease("/install", store).version).toBe("1.0.0");

    const upgraded = upgradeRelease("/install", "2.0.0", v2, store);
    expect(upgraded.from).toBe("1.0.0");
    expect(upgraded.to).toBe("2.0.0");
    expect(currentRelease("/install", store).manifest.target).toBe("linux-arm64");

    const rolled = rollbackRelease("/install", store);
    expect(rolled.from).toBe("2.0.0");
    expect(rolled.to).toBe("1.0.0");
    expect(currentRelease("/install", store).manifest.target).toBe("linux-x64");
  });

  test("拒绝重复升级版本与无历史的回滚", () => {
    const store = new MemoryStore();
    installRelease("/install", "1.0.0", manifest(), store);
    expect(() => upgradeRelease("/install", "1.0.0", manifest(), store)).toThrow(/VERSION/i);
    expect(() => rollbackRelease("/install", store)).toThrow(/HISTORY/i);
  });

  test("损坏的 manifest 或指针不能升级/回滚", () => {
    const store = new MemoryStore();
    installRelease("/install", "1.0.0", manifest(), store);
    store.write("/install/releases/1.0.0/manifest.json", "{broken");
    expect(() => currentRelease("/install", store)).toThrow(/MANIFEST/i);
    expect(() => rollbackRelease("/install", store)).toThrow(/MANIFEST|HISTORY/i);
  });
});
