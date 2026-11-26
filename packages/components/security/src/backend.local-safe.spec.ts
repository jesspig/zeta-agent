import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSafeBackend,
  type LocalSafeBackendOptions,
  type SpawnImpl,
  type WriteStage,
} from "./backend.local-safe";

/** T-12：原子写入注入、realpath→open 竞态与进程树取消/超时对账。 */
describe("T-12 local-safe 文件原子边界", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-t12-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = (options: LocalSafeBackendOptions = {}) =>
    createLocalSafeBackend({ allowedDirectories: [root], ...options });
  const temps = () => readdirSync(root).filter((name) => name.startsWith(".zeta-tmp-"));
  const file = (name: string) => join(root, name);

  test("短写循环：强制每次只写少量字节仍得到完整内容", async () => {
    const target = file("short.txt");
    writeFileSync(target, "OLD", "utf8");
    const backend = make({ maxWriteChunk: 3 });

    const result = await backend.file.write(target, "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(20));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bytes).toBe(Buffer.byteLength("ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(20)));
    expect(readFileSync(target, "utf8")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(20));
    expect(temps()).toEqual([]);
  });

  test("ENOSPC 注入在临时文件中途失败：旧文件完整保留且无残留临时文件", async () => {
    const target = file("enospc.txt");
    writeFileSync(target, "ORIGINAL-CONTENT", "utf8");
    let injected = false;
    const backend = make({
      maxWriteChunk: 2,
      writeHook: (stage: WriteStage) => {
        if (stage === "temp-writing" && !injected) {
          injected = true;
          throw new Error("ENOSPC: injected disk full");
        }
      },
    });

    const result = await backend.file.write(target, "NEW-CONTENT-THAT-NEVER-LANDS");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRITE_INCOMPLETE");
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL-CONTENT");
    expect(temps()).toEqual([]);
  });

  test("崩溃注入发生在 rename 之后：落盘的是完整新文件而非半写文件", async () => {
    const target = file("crash.txt");
    const newContent = "COMPLETE-NEW-FILE".repeat(50);
    writeFileSync(target, "OLD", "utf8");
    const seen: WriteStage[] = [];
    const backend = make({
      maxWriteChunk: 7,
      writeHook: (stage: WriteStage) => {
        seen.push(stage);
        if (stage === "renamed") throw new Error("SIMULATED_CRASH_AFTER_RENAME");
      },
    });

    const result = await backend.file.write(target, newContent);
    expect(result.ok).toBe(false);
    const onDisk = readFileSync(target, "utf8");
    expect([newContent, "OLD"]).toContain(onDisk);
    expect(onDisk).not.toBe(newContent.slice(0, 10));
    expect(temps()).toEqual([]);
    expect(seen).toContain("temp-synced");
    expect(seen).toContain("renamed");
  });

  test("原子 rename 顺序：fsync 先于 rename，rename 前目标仍是旧内容", async () => {
    const target = file("atomic.txt");
    writeFileSync(target, "OLD", "utf8");
    const order: WriteStage[] = [];
    let atBeforeRename = "";
    let atRenamed = "";
    const backend = make({
      maxWriteChunk: 4,
      writeHook: (stage: WriteStage) => {
        order.push(stage);
        if (stage === "before-rename") atBeforeRename = readFileSync(target, "utf8");
        if (stage === "renamed") atRenamed = readFileSync(target, "utf8");
      },
    });

    const result = await backend.file.write(target, "BRAND-NEW-CONTENT");
    expect(result.ok).toBe(true);
    expect(order.indexOf("temp-synced")).toBeLessThan(order.indexOf("before-rename"));
    expect(order.indexOf("before-rename")).toBeLessThan(order.indexOf("renamed"));
    expect(order.indexOf("renamed")).toBeLessThan(order.indexOf("dir-fsync"));
    expect(order.indexOf("dir-fsync")).toBeLessThan(order.indexOf("complete"));
    expect(atBeforeRename).toBe("OLD");
    expect(atRenamed).toBe("BRAND-NEW-CONTENT");
  });

  test("realpath→open 竞态：预检后替换目标被 fd dev/ino 校验挡下", async () => {
    const target = file("race.txt");
    writeFileSync(target, "BEFORE", "utf8");
    let swapped = false;
    const backend = make({
      openRaceHook: (stage) => {
        if (stage === "after-lstat-before-open" && !swapped) {
          swapped = true;
          rmSync(target);
          writeFileSync(target, "AFTER-SWAP", "utf8");
        }
      },
    });

    const result = await backend.file.read(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OPEN_RACE_VIOLATION");
    expect(readFileSync(target, "utf8")).toBe("AFTER-SWAP");
  });

  test("写入预检后目标被替换时放弃写入，保留替换后的完整文件", async () => {
    const target = file("race-write.txt");
    writeFileSync(target, "BEFORE", "utf8");
    const backend = make({
      writeHook: (stage) => {
        // 预检之后、rename 之前替换目标，使 rename 前复核失败。
        if (stage === "precheck") {
          rmSync(target);
          writeFileSync(target, "REPLACED", "utf8");
        }
      },
    });

    const result = await backend.file.write(target, "NEW");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OPEN_RACE_VIOLATION");
    expect(readFileSync(target, "utf8")).toBe("REPLACED");
    expect(temps()).toEqual([]);
  });

  test("中间路径段为符号链接时被逐级 no-symlink 校验拒绝", async () => {
    if (process.platform === "win32") return; // POSIX 符号链接；Windows junction 由 confinement.spec.ts 覆盖
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const inner = file("inner");
    mkdirSync(inner);
    writeFileSync(join(inner, "secret.txt"), "SECRET", "utf8");
    const link = file("linked");
    symlinkSync(inner, link, "dir");
    const backend = make();

    const result = await backend.file.read(join(link, "secret.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toMatch(/NOFOLLOW|CONFINEMENT/);
  });
});

describe("T-12 local-safe 进程树取消与超时对账", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-t12-shell-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = (spawn: SpawnImpl, options: LocalSafeBackendOptions = {}) =>
    createLocalSafeBackend({
      allowedDirectories: [root],
      spawn,
      operations: { "shell.start": "active" },
      ...options,
    });

  function injectedSpawn(options: { readonly exitOnCancel?: boolean; readonly options?: unknown } = {}): {
    spawn: SpawnImpl;
    cancelled: () => number;
    seenOptions: () => Record<string, unknown>;
  } {
    let cancelled = 0;
    let seen: Record<string, unknown> = {};
    let resolveExit: ((code: number) => void) | undefined;
    const spawn: SpawnImpl = (_argv, spawnOptions) => {
      seen = spawnOptions as unknown as Record<string, unknown>;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        pid: 4242,
        async cancel() {
          cancelled += 1;
          if (options.exitOnCancel === true) resolveExit?.(-1);
        },
        exited,
      };
    };
    return { spawn, cancelled: () => cancelled, seenOptions: () => seen };
  }

  test("结构化 shell 传递 cwd、净化 env、输出/CPU/时间限制与 spawn 实现", async () => {
    const { spawn, seenOptions } = injectedSpawn();
    const backend = make(spawn);

    const result = await backend.shell.start({
      argv: ["bash", "-c", "echo hi"],
      cwd: root,
      env: { PATH: "usr/bin", GITHUB_TOKEN: "secret" },
      denyEnv: ["GITHUB_TOKEN"],
      maxOutputBytes: 1234,
      maxCpuMs: 500,
      maxRuntimeMs: 2000,
    });
    expect(result.ok).toBe(true);
    const seen = seenOptions();
    expect(seen.cwd).toBe(root);
    expect(seen.maxOutputBytes).toBe(1234);
    expect(seen.maxCpuMs).toBe(500);
    expect(seen.maxRuntimeMs).toBe(2000);
    const env = seen.env as Record<string, string>;
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect(env.PATH).toBe("usr/bin");
  });

  test("手动取消确认进程树退出：termination=confirmed 且只调用一次 cancel", async () => {
    const { spawn, cancelled } = injectedSpawn({ exitOnCancel: true });
    const backend = make(spawn, { terminationGraceMs: 50 });
    const started = await backend.shell.start({ argv: ["sleep", "10"], cwd: root });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.value.cancel();
    const result = await started.value.exited;
    expect(result.termination).toBe("confirmed");
    expect(result.reconciliation).toBeUndefined();
    expect(cancelled()).toBe(1);
  });

  test("超时后进程树未退出：返回 unknown/reconciliation，不做普通重试", async () => {
    const { spawn, cancelled } = injectedSpawn({ exitOnCancel: false });
    const backend = make(spawn, { terminationGraceMs: 10 });
    const started = await backend.shell.start({
      argv: ["sleep", "30"],
      cwd: root,
      maxRuntimeMs: 5,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = await started.value.exited;
    expect(result.termination).toBe("unknown");
    expect(result.reconciliation).toContain("DO_NOT_RETRY");
    expect(cancelled()).toBe(1);
  });

  test("外部 AbortSignal 取消进程树并确认退出", async () => {
    const { spawn, cancelled } = injectedSpawn({ exitOnCancel: true });
    const backend = make(spawn, { terminationGraceMs: 50 });
    const controller = new AbortController();
    const started = await backend.shell.start({
      argv: ["sleep", "10"],
      cwd: root,
      signal: controller.signal,
    });
    expect(started.ok).toBe(true);
    controller.abort();
    if (!started.ok) return;
    const result = await started.value.exited;
    expect(result.termination).toBe("confirmed");
    expect(cancelled()).toBe(1);
  });

  test("未声明 shell.start 能力时结构化 shell 仍失败关闭，不调用 spawn", async () => {
    let spawned = 0;
    const backend = createLocalSafeBackend({
      allowedDirectories: [root],
      spawn: (() => {
        spawned += 1;
        throw new Error("SHOULD_NOT_SPAWN");
      }) as SpawnImpl,
    });
    const result = await backend.shell.start({ argv: ["echo", "hi"], cwd: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OPERATION_UNAVAILABLE");
    expect(spawned).toBe(0);
  });
});
