import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact";
import { start, type DeployConfig, type DeployHandle } from "./deployment";
import {
  currentRelease,
  readReleaseLog,
  type Release,
  type ReleaseProbe,
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
  readonly renames: string[] = [];
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
  rename(from: string, to: string): void {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.files.set(to, value);
    this.renames.push(`${from}->${to}`);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
}

const config: DeployConfig = { target: "linux-x64" };

function harness(store: ReleaseStore, starts: number[], failNext = false, probe?: ReleaseProbe) {
  let shouldFail = failNext;
  return createSupervisor({
    root: "/deploy",
    store,
    config,
    probe: probe ?? { startup: () => true, readiness: () => true },
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

  test("升级与回滚：旧 handle 停止、摘要切换、事件有序", async () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    const supervisor = harness(store, starts);
    supervisor.install("1.0.0", manifest([1]));
    const v1 = supervisor.digest;
    const first = supervisor.active;
    await supervisor.upgrade("2.0.0", manifest([1, 2]));
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

  test("跨进程重启恢复：新 supervisor 读 current 指针，不双启动", async () => {
    const store = new MemoryStore();
    const firstStarts: number[] = [];
    const first = harness(store, firstStarts);
    first.install("1.0.0", manifest([1]));
    await first.upgrade("2.0.0", manifest([1, 2]));
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

  test("升级走 staged 探针与原子切换，启动探针失败不切换 current", async () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    const supervisor = harness(store, starts, false, {
      startup: () => false,
      readiness: () => true,
    });
    supervisor.install("1.0.0", manifest([1]));
    const first = supervisor.active;

    await expect(supervisor.upgrade("2.0.0", manifest([1, 2]))).rejects.toThrow(/STAGED_STARTUP_FAILED/);

    expect(supervisor.version).toBe("1.0.0");
    expect(supervisor.active).toBe(first);
    expect(starts).toEqual([1]);
  });

  test("staged 成功后真实 startFactory 失败自动恢复上一版", async () => {
    const store = new MemoryStore();
    const starts: number[] = [];
    let failUpgradeStart = false;
    const supervisor = createSupervisor({
      root: "/deploy",
      store,
      config,
      probe: { startup: () => true, readiness: () => true },
      startFactory: (_release, nextConfig, generation) => {
        if (failUpgradeStart) {
          failUpgradeStart = false;
          throw new Error("UPGRADE_START_FAILED");
        }
        starts.push(generation);
        return start("daemon", nextConfig);
      },
    });
    supervisor.install("1.0.0", manifest([1]));
    failUpgradeStart = true;

    await expect(supervisor.upgrade("2.0.0", manifest([1, 2]))).rejects.toThrow("UPGRADE_START_FAILED");

    expect(supervisor.version).toBe("1.0.0");
    expect(supervisor.active?.liveness()).toBe(true);
    expect(starts).toEqual([1, 3]);
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

  test("staged 日志保留 stage/verified/probe/switch 原子提交证据", async () => {
    const store = new MemoryStore();
    const supervisor = harness(store, []);
    supervisor.install("1.0.0", manifest([1]));

    await supervisor.upgrade("2.0.0", manifest([1, 2]));

    const actions = readReleaseLog(store, "/deploy").map((event) => event.action);
    for (const action of ["stage", "verified", "probe", "switch"] as const) expect(actions).toContain(action);
    expect(store.renames.some((entry) => entry.includes("current.json.tmp->") && entry.endsWith("/current.json"))).toBe(true);
    supervisor.close();
  });
});
