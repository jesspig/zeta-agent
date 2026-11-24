import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact";
import { start, type DeployConfig, type DeployHandle } from "./deployment";
import {
  currentRelease,
  type Release,
  type ReleaseStore,
} from "./lifecycle";
import { createSupervisor, type SupervisorEvent } from "./supervisor";

function manifest(bytes: readonly number[]): ArtifactManifest {
  const content = new Uint8Array(bytes);
  return {
    version: 1,
    target: "linux-x64",
    binary: {
      arch: "x64",
      path: "zeta",
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
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
}

const config: DeployConfig = { target: "linux-x64" };

function harness(store: ReleaseStore, starts: number[], failNext = false) {
  let shouldFail = failNext;
  return createSupervisor({
    root: "/deploy",
    store,
    config,
    startFactory: (_release: Release, nextConfig: DeployConfig, generation: number): DeployHandle => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("START_FAILED");
      }
      starts.push(generation);
      return start("daemon", nextConfig);
    },
  });
}

describe("T-21 部署故障 / 重启 / 升级 / 回滚", () => {
  test("故障后恢复只启动一次，代次递增且旧 handle 已停止", () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    const supervisor = harness(store, starts);
    supervisor.install("1.0.0", manifest([1, 2, 3]));
    expect(starts).toEqual([1]);
    const first = supervisor.active;
    expect(first).toBeDefined();

    supervisor.fault();
    expect(supervisor.active).toBeUndefined();
    expect(first!.liveness()).toBe(false);
    supervisor.recover();
    expect(starts).toEqual([1, 2]);
    expect(supervisor.generation).toBe(2);
    expect(supervisor.liveness()).toBe(true);
    supervisor.close();
  });

  test("升级与回滚：旧 handle 停止、摘要切换、事件有序", () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    const supervisor = harness(store, starts);
    supervisor.install("1.0.0", manifest([1]));
    const v1 = supervisor.digest;
    const first = supervisor.active;
    supervisor.upgrade("2.0.0", manifest([1, 2]));
    expect(supervisor.version).toBe("2.0.0");
    expect(supervisor.digest).not.toBe(v1);
    expect(first!.liveness()).toBe(false);
    const second = supervisor.active;
    supervisor.rollback();
    expect(supervisor.version).toBe("1.0.0");
    expect(supervisor.digest).toBe(v1);
    expect(second!.liveness()).toBe(false);
    expect(supervisor.active!.liveness()).toBe(true);
    expect(starts).toEqual([1, 2, 3]);
    expect(supervisor.events.map((event: SupervisorEvent) => event.type)).toEqual(["install", "upgrade", "rollback"]);
    supervisor.close();
  });

  test("跨进程重启恢复：新 supervisor 读 current 指针，不双启动", () => {
    const store = new MemoryStore();
    const firstStarts: number[] = [];
    const first = harness(store, firstStarts);
    first.install("1.0.0", manifest([1]));
    first.upgrade("2.0.0", manifest([1, 2]));
    first.close();
    expect(currentRelease("/deploy", store).version).toBe("2.0.0");

    const secondStarts: number[] = [];
    const recovered = harness(store, secondStarts);
    recovered.recover();
    expect(recovered.version).toBe("2.0.0");
    expect(secondStarts).toEqual([1]);
    expect(recovered.generation).toBe(1);
    recovered.close();
  });

  test("启动故障 fail-closed：不保留半成品 handle，可重试恢复", () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    const supervisor = harness(store, starts, true);
    expect(() => supervisor.install("1.0.0", manifest([1]))).toThrow("START_FAILED");
    expect(supervisor.active).toBeUndefined();
    expect(supervisor.events.some((event) => event.type === "start.failed")).toBe(true);
    supervisor.recover();
    expect(supervisor.active).toBeDefined();
    expect(supervisor.version).toBe("1.0.0");
    supervisor.close();
  });
});
