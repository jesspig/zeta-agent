import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertOperation,
  assertShellEgress,
  createStructuredExecutionBackend,
  currentPlatform,
  isCriticalLayerDegraded,
  isStructuredExecutionBackend,
  profileSupport,
  type BackendEvidence,
  type Capabilities,
  type ExpectedStat,
  type ExecutionBackend,
  type FilePatch,
  type FileStatSnapshot,
  type LayerState,
  type ListEntry,
  type NodePlatform,
  type OpenOptions,
  type OpenedFile,
  type OperationCapabilityReport,
  type OperationName,
  type ProcessHandle,
  type ShellRequest,
  type ShellResult,
  type StructuredExecutionBackend,
  type StructuredFileBackend,
  type StructuredResult,
  type StructuredShellBackend,
} from "./backend";

/** 原子写入的阶段；注入钩子可在此精确制造 ENOSPC/短写/崩溃，验证旧文件与完整新文件二选一。 */
export type WriteStage =
  | "precheck"
  | "temp-opened"
  | "temp-writing"
  | "temp-synced"
  | "before-rename"
  | "renamed"
  | "dir-fsync"
  | "complete";

/** realpath→open 竞态窗口的注入点：在 precheck 快照之后、open 之前替换目标。 */
export type OpenRaceStage = "after-lstat-before-open" | "after-open";

export interface LocalSafeBackendOptions {
  /** 后端自述名；local-full 复用同一真实边界时使用自己的名字。 */
  readonly name?: string;
  readonly allowedDirectories?: readonly string[];
  readonly platform?: NodePlatform;
  /** 故障注入：返回 true 时写入在触碰宿主前失败，用于回滚测试。 */
  readonly failWrite?: (path: string) => boolean;
  /** 阶段注入：抛错模拟 ENOSPC/中断/崩溃；不抛错时记录顺序用于原子性验证。 */
  readonly writeHook?: (stage: WriteStage, path: string) => void;
  /** 强制单次 writeSync 的最大字节数，用于验证短写循环。 */
  readonly maxWriteChunk?: number;
  /** 在 lstat 快照与 open 之间注入替换，验证 fd inode/mount 一致性校验。 */
  readonly openRaceHook?: (stage: OpenRaceStage, path: string) => void;
  /** 进程生成注入，保证取消/输出测试不依赖真实平台语义。 */
  readonly spawn?: SpawnImpl;
  readonly now?: () => number;
  /** 取消后等待进程树退出的默认宽限期；0 表示立即判定。 */
  readonly terminationGraceMs?: number;
  /** 能力覆盖：仅用于接入真实执行器时声明 shell 等能力，缺省按 profile 诚实报告。 */
  readonly operations?: Partial<Record<OperationName, LayerState>>;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  cancel(): Promise<void>;
  readonly exited: Promise<number>;
}

export type OutputSink = (kind: "stdout" | "stderr", chunk: string) => void;

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly maxOutputBytes?: number;
  readonly maxCpuMs?: number;
  readonly maxRuntimeMs?: number;
}

export type SpawnImpl = (
  argv: readonly string[],
  options: SpawnOptions,
  sink: OutputSink
) => SpawnedProcess;

/** 默认会被子进程继承的敏感键；即使未显式 deny 也一律剥离。 */
const DEFAULT_DENY_ENV: readonly string[] = Object.freeze([
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AZURE_STORAGE_KEY",
]);

export function buildShellEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: {
    readonly denyEnv?: readonly string[];
    readonly fakeCredentials?: Readonly<Record<string, string>>;
  } = {}
): Record<string, string> {
  const deny = new Set([...DEFAULT_DENY_ENV, ...(options.denyEnv ?? [])]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (deny.has(key) || value === undefined) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(options.fakeCredentials ?? {})) {
    env[key] = value;
  }
  return env;
}

export interface OutputLimit {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export function enforceOutputLimit(stdout: string, maxBytes: number): OutputLimit {
  const bytes = Buffer.byteLength(stdout, "utf8");
  if (bytes <= maxBytes) return { stdout, stderr: "", truncated: false };
  let cut = stdout.length;
  while (cut > 0 && Buffer.byteLength(stdout.slice(0, cut), "utf8") > maxBytes) {
    cut -= 1;
  }
  return { stdout: stdout.slice(0, cut), stderr: "", truncated: true };
}

function isInside(absolute: string, base: string): boolean {
  const rel = relative(base, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** realpath 校验：词法边界 + 实际目标边界，识别 junction/symlink 越界。 */
export function confinedPath(path: string, allowed: readonly string[]): string {
  const absolute = resolve(path);
  if (!allowed.some((directory) => isInside(absolute, resolve(directory)))) {
    throw new Error(`TOOL_CONFINEMENT_VIOLATION: ${path} is outside allowed directories`);
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(absolute);
  } catch {
    let ancestor = absolute;
    const missing: string[] = [];
    for (;;) {
      try {
        const ancestorReal = realpathSync(ancestor);
        realTarget = join(ancestorReal, ...missing.reverse());
        break;
      } catch {
        const next = dirname(ancestor);
        if (next === ancestor) return absolute;
        missing.push(ancestor.slice(next.length + sep.length));
        ancestor = next;
      }
    }
  }
  if (!allowed.some((directory) => isInside(realTarget, realpathSync(resolve(directory))))) {
    throw new Error(`TOOL_CONFINEMENT_VIOLATION: ${path} resolves outside allowed directories`);
  }
  return realTarget;
}

function snapshot(stat: ReturnType<typeof fstatSync>): FileStatSnapshot {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    mode: Number(stat.mode),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
  };
}

function sameSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    left.isFile === right.isFile
  );
}

function matchesExpected(actual: FileStatSnapshot, expected: ExpectedStat | undefined): boolean {
  if (expected === undefined) return true;
  if (expected.dev !== undefined && expected.dev !== actual.dev) return false;
  if (expected.ino !== undefined && expected.ino !== actual.ino) return false;
  if (expected.size !== undefined && expected.size !== actual.size) return false;
  if (expected.mtimeMs !== undefined && expected.mtimeMs !== actual.mtimeMs) return false;
  return true;
}

function safeFlags(extra: number): number {
  let flags = extra;
  const O = (fsConstants as unknown as { O?: Record<string, number | undefined> }).O ?? {};
  if (typeof O.NOFOLLOW === "number") flags |= O.NOFOLLOW;
  if (typeof O.NONBLOCK === "number") flags |= O.NONBLOCK;
  return flags;
}

function assertNofollow(original: string, target: string): void {
  try {
    const lstat = lstatSync(original);
    if (lstat.isSymbolicLink()) {
      throw new Error("NOFOLLOW_VIOLATION: symbolic link/reparse point is not allowed");
    }
    const targetStat = lstatSync(target);
    if (targetStat.dev !== lstat.dev || targetStat.ino !== lstat.ino) {
      throw new Error("NOFOLLOW_VIOLATION: path target changed during open");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("NOFOLLOW")) throw error;
    // lstat 失败交给后续 open/fstat 处理。
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  for (;;) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

function defaultSpawn(platform: NodePlatform): SpawnImpl {
  return (argv, options, sink) => {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("SHELL_ARGV_EMPTY");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // 运行时间上限由 Node 透明强制（超时 killSignal）；我们仍用独立
      // AbortController 取消整个进程树并确认终止，避免把平台差异当成成功。
      ...(options.maxRuntimeMs !== undefined && options.maxRuntimeMs > 0
        ? { timeout: options.maxRuntimeMs, killSignal: "SIGKILL" as const }
        : {}),
    });
    let cancelled = false;
    child.stdout?.on("data", (chunk: Buffer | string) => sink("stdout", String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => sink("stderr", String(chunk)));
    const exit = new Promise<number>((resolveExit) => {
      child.on("error", () => resolveExit(-1));
      child.on("close", (code) => resolveExit(code ?? -1));
    });
    return {
      pid: child.pid,
      async cancel() {
        if (cancelled) return;
        cancelled = true;
        if (platform === "win32" && child.pid !== undefined) {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
      },
      exited: exit,
    };
  };
}

/** 结构化文件/进程边界：所有文件 I/O 与进程生成都封装在此，工具层不持有宿主 I/O。 */
export function createLocalSafeBackend(options: LocalSafeBackendOptions = {}): StructuredExecutionBackend {
  const name = options.name ?? "local-safe";
  const allowed = options.allowedDirectories ?? [];
  const platform = options.platform ?? currentPlatform();
  const now = options.now ?? Date.now;
  const evidenceLog: BackendEvidence[] = [];
  const support = profileSupport("local-safe", platform);
  const operations: OperationCapabilityReport =
    options.operations === undefined
      ? support.operations
      : { operations: { ...support.operations.operations, ...options.operations } };

  const record = (operation: OperationName, target: string | undefined, ok: boolean): BackendEvidence => {
    const entry: BackendEvidence = { backend: name, operation, target, at: now(), ok };
    evidenceLog.push(entry);
    return entry;
  };
  const success = <T>(operation: OperationName, target: string | undefined, value: T): StructuredResult<T> => ({
    ok: true,
    value,
    evidence: record(operation, target, true),
  });
  const failure = (operation: OperationName, target: string | undefined, code: string, error: string): StructuredResult<never> => ({
    ok: false,
    code,
    error,
    evidence: record(operation, target, false),
  });

  /**
   * 逐级 no-symlink 校验：从目标向上走到允许根目录，禁止任何路径段是符号链接/reparse point。
   * 与 confinedPath 的 realpath 校验叠加，缩小 realpath→open 之间被替换的窗口。
   */
  const assertNoSymlinkWithinAllowed = (target: string): void => {
    const bases = allowed.map((directory) => {
      try {
        return realpathSync(resolve(directory));
      } catch {
        return resolve(directory);
      }
    });
    const stop = new Set(bases.filter((base) => isInside(target, base)));
    let cursor = target;
    for (;;) {
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) throw new Error("NOFOLLOW_VIOLATION: symbolic link/reparse point in path");
      } catch (error) {
        if (error instanceof Error && error.message.includes("NOFOLLOW")) throw error;
        // 中间层不存在交给后续 open/lstat 处理。
      }
      if (stop.has(resolve(cursor))) break;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  };

  /** 打开后以 fstat 校验 dev/ino 与预检快照一致，阻断 realpath→open 的目标替换竞态。 */
  const openChecked = (path: string, write: boolean, opts: OpenOptions = {}): { fd: number; stat: FileStatSnapshot; target: string } => {
    if (opts.nofollow === false) throw new Error("NOFOLLOW_CANNOT_BE_DISABLED");
    const target = confinedPath(path, allowed);
    assertNofollow(resolve(path), target);
    assertNoSymlinkWithinAllowed(resolve(path));
    assertNoSymlinkWithinAllowed(target);

    let pre: FileStatSnapshot | undefined;
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("NOFOLLOW_VIOLATION: target is a symbolic link");
      pre = snapshot(stat);
    } catch (error) {
      if (error instanceof Error && error.message.includes("NOFOLLOW")) throw error;
      if (!write) throw error;
    }
    options.openRaceHook?.("after-lstat-before-open", target);

    const flags = write
      ? safeFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT)
      : safeFlags(fsConstants.O_RDONLY);
    const fd = openSync(target, flags, 0o666);
    try {
      options.openRaceHook?.("after-open", target);
      const stat = snapshot(fstatSync(fd));
      if (pre !== undefined && !sameSnapshot(pre, stat)) {
        throw new Error("OPEN_RACE_VIOLATION: fd identity changed after precheck");
      }
      if (!stat.isFile) throw new Error("UNSUPPORTED_FILE_TYPE: only regular files are allowed");
      if (!matchesExpected(stat, opts.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
      return { fd, stat, target };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  };

  /**
   * 原子写入：同目录临时文件 → 完整写入循环（处理短写）→ fsync → rename → 目录 fsync。
   * 失败/中断时清理临时文件，宿主上只保留完整旧文件或完整新文件，绝不出现半写内容。
   */
  const writeChecked = (path: string, content: string, opts: OpenOptions = {}) => {
    if (opts.nofollow === false) throw new Error("NOFOLLOW_CANNOT_BE_DISABLED");
    const target = confinedPath(path, allowed);
    assertNofollow(resolve(path), target);
    assertNoSymlinkWithinAllowed(resolve(path));
    assertNoSymlinkWithinAllowed(target);
    if (options.failWrite?.(target) === true) throw new Error("INJECTED_WRITE_FAILURE");

    let before: FileStatSnapshot | undefined;
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("NOFOLLOW_VIOLATION: target is a symbolic link");
      if (!stat.isFile) throw new Error("UNSUPPORTED_FILE_TYPE: only regular files are allowed");
      before = snapshot(stat);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("NOFOLLOW") || error.message.includes("FILE_TYPE"))) throw error;
      // ENOENT：新建文件场景，before 留空。
    }
    if (opts.expected !== undefined) {
      if (before === undefined) throw new Error("EXPECTED_STAT_MISMATCH: file does not exist");
      if (!matchesExpected(before, opts.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
    }
    options.writeHook?.("precheck", target);

    const dir = dirname(target);
    const tmp = join(dir, `.zeta-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const buffer = Buffer.from(content, "utf8");
    let tmpFd: number | undefined;
    try {
      tmpFd = openSync(tmp, safeFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
      options.writeHook?.("temp-opened", tmp);
      let written = 0;
      const chunkSize = options.maxWriteChunk ?? buffer.length;
      while (written < buffer.length) {
        const size = Math.min(chunkSize, buffer.length - written);
        const count = writeSync(tmpFd, buffer, written, size);
        if (count <= 0) throw new Error("WRITE_STALL: short write made no progress");
        written += count;
        options.writeHook?.("temp-writing", tmp);
      }
      if (written !== buffer.length) throw new Error("WRITE_INCOMPLETE: short write did not finish");
      fsyncSync(tmpFd);
      options.writeHook?.("temp-synced", tmp);
      closeSync(tmpFd);
      tmpFd = undefined;

      const tmpStat = snapshot(lstatSync(tmp));
      if (!tmpStat.isFile || tmpStat.size !== buffer.length) {
        throw new Error("WRITE_INCOMPLETE: temp file size mismatch");
      }

      if (before !== undefined) {
        let current: FileStatSnapshot | undefined;
        try {
          current = snapshot(lstatSync(target));
        } catch {
          current = undefined;
        }
        if (current === undefined || !sameSnapshot(before, current)) {
          throw new Error("OPEN_RACE_VIOLATION: target changed after precheck");
        }
      }
      options.writeHook?.("before-rename", tmp);
      renameSync(tmp, target);
      options.writeHook?.("renamed", target);

      // Windows 的目录句柄不支持 fsync；rename 本身仍是原子的，因此平台差异不视为写入失败。
      options.writeHook?.("dir-fsync", dir);
      try {
        const dirFd = openSync(dir, safeFlags(fsConstants.O_RDONLY));
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // 平台不支持目录 fsync；崩溃安全性由同目录原子 rename 保证。
      }
      options.writeHook?.("complete", target);
    } catch (error) {
      if (tmpFd !== undefined) {
        try {
          closeSync(tmpFd);
        } catch {
          // 已关闭或句柄失效，忽略。
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // 临时文件可能已被 rename 消费或从未创建，忽略。
      }
      throw error;
    }

    const after = snapshot(lstatSync(target));
    return { before: before ?? after, after };
  };

  const file: StructuredFileBackend = {
    async open(path, opts) {
      assertOperation(operations, "file.read");
      try {
        const { fd, stat, target } = openChecked(path, false, opts);
        let closed = false;
        const handle: OpenedFile = {
          path: target,
          stat,
          async readText() {
            if (closed) throw new Error("FILE_HANDLE_CLOSED");
            const content = readFileSync(fd, "utf8");
            return { content, stat: snapshot(fstatSync(fd)) };
          },
          async close() {
            if (closed) return;
            closed = true;
            closeSync(fd);
          },
        };
        return success("file.read", path, handle);
      } catch (error) {
        return failure("file.read", path, fileErrorCode(error), String((error as Error).message));
      }
    },
    async read(path, opts) {
      assertOperation(operations, "file.read");
      try {
        const { fd, stat, target } = openChecked(path, false, opts);
        try {
          const content = readFileSync(fd, "utf8");
          const after = snapshot(fstatSync(fd));
          if (!matchesExpected(after, opts?.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
          void target;
          return success("file.read", path, { content, stat: after });
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        return failure("file.read", path, fileErrorCode(error), String((error as Error).message));
      }
    },
    async list(path) {
      assertOperation(operations, "file.list");
      try {
        const target = confinedPath(path, allowed);
        assertNofollow(resolve(path), target);
        const stat = lstatSync(target);
        if (!stat.isDirectory()) throw new Error("NOT_A_DIRECTORY");
        const entries: ListEntry[] = readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other",
        }));
        return success("file.list", path, { entries, stat: snapshot(stat) });
      } catch (error) {
        return failure("file.list", path, fileErrorCode(error), String((error as Error).message));
      }
    },
    async write(path, content, opts) {
      assertOperation(operations, "file.write");
      try {
        const { before, after } = writeChecked(path, content, opts);
        void before;
        return success("file.write", path, { bytes: Buffer.byteLength(content, "utf8"), stat: after });
      } catch (error) {
        return failure("file.write", path, fileErrorCode(error), String((error as Error).message));
      }
    },
    async applyPatch(patches, applyOptions) {
      const operation = applyOptions?.operation ?? "file.applyPatch";
      try {
        assertOperation(operations, operation);
      } catch (error) {
        return failure(operation, undefined, "OPERATION_UNAVAILABLE", String((error as Error).message));
      }
      const prepared: Array<{
        path: string;
        original: string;
        content: string;
        before: FileStatSnapshot;
        replacements: number;
      }> = [];
      for (const patch of patches) {
        try {
          assertOperation(operations, patch.capability ?? "file.write");
        } catch (error) {
          return failure(operation, patch.path, "OPERATION_UNAVAILABLE", String((error as Error).message));
        }
        if (patch.from.length === 0) {
          return failure(operation, patch.path, "PATCH_VALIDATION_FAILED", "from must not be empty");
        }
        const read = await file.read(patch.path, { expected: patch.expected });
        if (!read.ok) return failure(operation, patch.path, "PATCH_VALIDATION_FAILED", read.error);
        const replacements = countOccurrences(read.value.content, patch.from);
        if (replacements === 0) {
          return failure(operation, patch.path, "PATCH_VALIDATION_FAILED", `pattern not found in ${patch.path}`);
        }
        prepared.push({
          path: patch.path,
          original: read.value.content,
          content: replaceAll(read.value.content, patch.from, patch.to),
          before: read.value.stat,
          replacements,
        });
      }

      if (applyOptions?.dryRun === true) {
        return success(operation, undefined, {
          applied: [],
          rolledBack: [],
          dryRun: true,
          changes: prepared.map((item) => ({
            path: item.path,
            replacements: item.replacements,
            bytes: Buffer.byteLength(item.content, "utf8"),
            before: item.before,
            after: item.before,
          })),
        });
      }

      const applied: string[] = [];
      const changes: Array<{
        path: string;
        replacements: number;
        bytes: number;
        before: FileStatSnapshot;
        after: FileStatSnapshot;
      }> = [];
      for (const item of prepared) {
        try {
          const written = await file.write(item.path, item.content, { expected: asExpected(item.before) });
          if (!written.ok) throw new Error(written.error);
          applied.push(item.path);
          changes.push({
            path: item.path,
            replacements: item.replacements,
            bytes: written.value.bytes,
            before: item.before,
            after: written.value.stat,
          });
        } catch (error) {
          const rolledBack: string[] = [];
          for (const path of [...applied].reverse()) {
            const original = prepared.find((item2) => item2.path === path);
            if (original === undefined) continue;
            const restore = await file.write(path, original.original, {});
            if (restore.ok) rolledBack.push(path);
          }
          return failure(operation, item.path, "PATCH_WRITE_FAILED", `${String((error as Error).message)}; rolledBack=${rolledBack.join(",")}`);
        }
      }
      return success(operation, undefined, { applied, rolledBack: [], dryRun: false, changes });
    },
  };

  const spawnImpl = options.spawn ?? defaultSpawn(platform);
  const defaultGraceMs = options.terminationGraceMs ?? 2000;
  const shell: StructuredShellBackend = {
    async start(request) {
      try {
        assertOperation(operations, "shell.start");
        assertWorkspaceConfinedInBackend(request.cwd, allowed);
        if (request.egress?.target !== undefined) {
          assertShellEgress(request.egress.policy, request.egress.target);
        }
        if (request.egress !== undefined && request.egress.target === undefined) {
          throw new Error("EGRESS_DENIED: shell requires an explicit target under egress binding");
        }
        const env = buildShellEnv(request.env ?? {}, request);
        const maxBytes = request.maxOutputBytes ?? 1024 * 1024;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const child = spawnImpl(
          request.argv,
          {
            cwd: request.cwd,
            env,
            maxOutputBytes: maxBytes,
            ...(request.maxCpuMs === undefined ? {} : { maxCpuMs: request.maxCpuMs }),
            ...(request.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: request.maxRuntimeMs }),
          },
          (kind, chunk) => {
            if (kind === "stdout") {
              stdout += chunk;
              const limited = enforceOutputLimit(stdout, maxBytes);
              stdout = limited.stdout;
              if (limited.truncated) truncated = true;
            } else {
              stderr += chunk;
              const limited = enforceOutputLimit(stderr, maxBytes);
              stderr = limited.stdout;
              if (limited.truncated) truncated = true;
            }
          }
        );

        // 超时与外部 signal 都只经独立 AbortController 取消进程树，避免把
        // "发出 kill" 误当作 "已确认终止"。
        const controller = new AbortController();
        let abortReason: "external" | "timeout" | "manual" | undefined;
        let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let settle: (result: ShellResult) => void = () => {};
        const exited = new Promise<ShellResult>((resolveResult) => {
          settle = resolveResult;
        });
        const finish = (exitCode: number, termination: "confirmed" | "unknown"): void => {
          if (settled) return;
          settled = true;
          if (runtimeTimer !== undefined) clearTimeout(runtimeTimer);
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          const unknown = termination === "unknown";
          settle({
            exitCode,
            stdout,
            stderr,
            terminated: truncated || abortReason !== undefined,
            truncated,
            termination,
            ...(unknown
              ? { reconciliation: `SHELL_TERMINATION_UNKNOWN:${abortReason ?? "cancel"};DO_NOT_RETRY` }
              : {}),
          });
          if (unknown) record("shell.start", request.cwd, false);
        };
        controller.signal.addEventListener(
          "abort",
          () => {
            if (settled) return;
            void Promise.resolve()
              .then(() => child.cancel())
              .catch(() => {});
            const graceMs = request.terminationGraceMs ?? defaultGraceMs;
            graceTimer = setTimeout(() => finish(-1, "unknown"), Math.max(0, graceMs));
          },
          { once: true }
        );
        const requestCancel = (reason: "external" | "timeout" | "manual"): void => {
          if (abortReason !== undefined) return;
          abortReason = reason;
          controller.abort();
        };
        const onExternalAbort = (): void => requestCancel("external");
        request.signal?.addEventListener("abort", onExternalAbort, { once: true });
        if (request.signal?.aborted === true) onExternalAbort();
        if (request.maxRuntimeMs !== undefined && request.maxRuntimeMs > 0) {
          runtimeTimer = setTimeout(() => requestCancel("timeout"), request.maxRuntimeMs);
        }
        void child.exited.then(
          (code) => finish(code, "confirmed"),
          () => finish(-1, "unknown")
        );

        const handle: ProcessHandle = {
          pid: child.pid,
          async cancel() {
            requestCancel("manual");
          },
          exited,
        };
        return success("shell.start", request.cwd, handle);
      } catch (error) {
        return failure("shell.start", request.cwd, shellErrorCode(error), String((error as Error).message));
      }
    },
  };

  return createStructuredExecutionBackend({
    name,
    capabilities: { ...support.capabilities } as Capabilities,
    executor: () => ({ exitCode: 1, stdout: "", stderr: "SHELL_UNSUPPORTED_ON_LOCAL_SAFE", isolated: null }),
    operations,
    file,
    shell,
    evidence: () => [...evidenceLog],
  });
}

/**
 * local-full：复用同一真实文件/进程边界，但显式启用 shell.start。
 * 不是把 local-safe 改成 active，而是用 profile 声明驱动真实执行器：
 * 声明 active 的每一项都由本文件的真实实现支撑，失败仍关闭。
 */
export function createLocalFullBackend(options: LocalSafeBackendOptions = {}): StructuredExecutionBackend {
  const support = profileSupport("local-full", options.platform ?? currentPlatform());
  return createLocalSafeBackend({
    ...options,
    name: options.name ?? "local-full",
    operations: {
      ...support.operations.operations,
      ...options.operations,
    },
  });
}

function assertWorkspaceConfinedInBackend(cwd: string, allowed: readonly string[]): void {
  const absolute = resolve(cwd);
  if (!allowed.some((directory) => isInside(absolute, resolve(directory)))) {
    throw new Error(`TOOL_CONFINEMENT_VIOLATION: cwd ${cwd} is outside allowed directories`);
  }
}

function fileErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CONFINEMENT")) return "CONFINEMENT_VIOLATION";
  if (message.includes("NOFOLLOW")) return "NOFOLLOW_VIOLATION";
  if (message.includes("OPEN_RACE")) return "OPEN_RACE_VIOLATION";
  if (message.includes("EXPECTED_STAT")) return "EXPECTED_STAT_MISMATCH";
  if (message.includes("FILE_TYPE")) return "UNSUPPORTED_FILE_TYPE";
  if (message.includes("INJECTED_WRITE")) return "INJECTED_WRITE_FAILURE";
  if (message.includes("ENOSPC") || message.includes("WRITE_STALL") || message.includes("WRITE_INCOMPLETE")) {
    return "WRITE_INCOMPLETE";
  }
  return "FILE_OPERATION_FAILED";
}

function legacyFailResult(
  backend: string,
  operation: OperationName,
  code: string,
  error: string,
  target?: string
): StructuredResult<never> {
  return { ok: false, code, error, evidence: { backend, operation, target, at: Date.now(), ok: false } };
}

function shellErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("OPERATION_UNAVAILABLE")) return "OPERATION_UNAVAILABLE";
  if (message.includes("CONFINEMENT")) return "CONFINEMENT_VIOLATION";
  if (message.includes("EGRESS")) return "EGRESS_DENIED";
  return "SHELL_OPERATION_FAILED";
}

function asExpected(stat: FileStatSnapshot): ExpectedStat {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * 兼容层：旧式命令 backend（只有 name/capabilities/run/dispose）通过 run() 授权，
 * 再把真实文件 I/O 委托给 local-safe 边界；任何失败都在宿主变化之前返回。
 */
export function resolveStructuredBackend(
  backend: ExecutionBackend,
  allowedDirectories: readonly string[] = []
): StructuredExecutionBackend {
  if (isStructuredExecutionBackend(backend)) return backend;
  const local = createLocalSafeBackend({ allowedDirectories });
  const evidenceLog: BackendEvidence[] = [];
  const operations: OperationCapabilityReport = inferLegacyOperations(backend.capabilities());
  const gated = createGatedStructuredBackend({
    name: backend.name,
    operations,
    evidence: evidenceLog,
    authorize: async (operation, target) => {
      const arg =
        operation === "file.applyPatch"
          ? "fs:edit"
          : operation.startsWith("file.")
            ? `fs:${operation.slice("file.".length)}`
            : operation;
      try {
        const result = await backend.run({ argv: [arg, target ?? ""] });
        if (result.exitCode !== 0) {
          return `BACKEND_DENIED: exit ${result.exitCode}`;
        }
      } catch (error) {
        return `BACKEND_ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      return undefined;
    },
    delegate: local,
    allowedDirectories,
  });
  /**
   * 旧式 backend 的结构化 shell 适配：工具层只调用 shell.start(ShellRequest)，
   * 由这里以 "shell.start" 标记 + 完整 argv 交给 backend.run 授权执行，
   * 杜绝 {argv:[flag,command]} 形式的直接绕过。
   */
  const legacyShell: StructuredShellBackend = {
    async start(request) {
      try {
        assertOperation(operations, "shell.start");
        const result = await backend.run({ argv: ["shell.start", ...request.argv] });
        evidenceLog.push({ backend: backend.name, operation: "shell.start", target: request.cwd, at: Date.now(), ok: result.exitCode === 0 });
        if (result.exitCode !== 0) {
          return legacyFailResult(backend.name, "shell.start", "SHELL_EXEC_FAILED", `exit ${result.exitCode}`, request.cwd);
        }
        const handle: ProcessHandle = {
          pid: undefined,
          exited: Promise.resolve({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            terminated: false,
            truncated: false,
            termination: "confirmed",
          }),
          cancel: async () => {},
        };
        return {
          ok: true,
          value: handle,
          evidence: { backend: backend.name, operation: "shell.start", target: request.cwd, at: Date.now(), ok: true },
        };
      } catch (error) {
        evidenceLog.push({ backend: backend.name, operation: "shell.start", target: request.cwd, at: Date.now(), ok: false });
        return legacyFailResult(backend.name, "shell.start", "SHELL_EXEC_FAILED", String((error as Error).message), request.cwd);
      }
    },
  };

  return createStructuredExecutionBackend({
    name: backend.name,
    capabilities: { ...backend.capabilities() },
    executor: (command, runOptions) => backend.run(command, runOptions),
    operations,
    file: gated.file,
    shell: legacyShell,
    evidence: () => [...evidenceLog],
  });
}

function inferLegacyOperations(capabilities: Capabilities): OperationCapabilityReport {
  const state = isCriticalLayerDegraded(capabilities) ? "degraded" : "active";
  const operations = Object.fromEntries(
    ["file.read", "file.list", "file.write", "file.applyPatch", "shell.start", "session.open", "cleanup"].map(
      (name) => [name, state]
    )
  ) as Readonly<Partial<Record<OperationName, "active" | "degraded">>>;
  return { operations };
}

interface GatedConfig {
  readonly name: string;
  readonly operations: OperationCapabilityReport;
  readonly evidence: BackendEvidence[];
  readonly authorize: (operation: OperationName, target: string | undefined) => Promise<string | undefined>;
  readonly delegate: StructuredExecutionBackend;
  readonly allowedDirectories: readonly string[];
}

/** run() 授权 → 委托真实边界；证据与失败关闭集中在此。 */
export function createGatedStructuredBackend(config: GatedConfig): {
  file: StructuredFileBackend;
  shell: StructuredShellBackend;
} {
  const fail = (operation: OperationName, target: string | undefined, code: string, error: string): StructuredResult<never> => {
    const evidence: BackendEvidence = { backend: config.name, operation, target, at: Date.now(), ok: false };
    config.evidence.push(evidence);
    return { ok: false, code, error, evidence };
  };
  const pass = (operation: OperationName, target: string | undefined): void => {
    config.evidence.push({ backend: config.name, operation, target, at: Date.now(), ok: true });
  };
  const gate = async (operation: OperationName, target: string | undefined): Promise<StructuredResult<never> | undefined> => {
    assertOperation(config.operations, operation);
    const denial = await config.authorize(operation, target);
    if (denial !== undefined) return fail(operation, target, "BACKEND_DENIED", denial);
    return undefined;
  };

  // 越界目标在授权前就被拒绝：既不留 backend 调用证据，也不触碰宿主。
  const preflight = (operation: OperationName, path: string): StructuredResult<never> | undefined => {
    try {
      confinedPath(path, config.allowedDirectories);
      return undefined;
    } catch (error) {
      return fail(operation, path, "CONFINEMENT_VIOLATION", String((error as Error).message));
    }
  };

  const file: StructuredFileBackend = {
    async open(path, opts) {
      const bad = preflight("file.read", path);
      if (bad !== undefined) return bad;
      const denied = await gate("file.read", path);
      if (denied !== undefined) return denied;
      const result = await config.delegate.file.open(path, opts);
      pass("file.read", path);
      return result;
    },
    async read(path, opts) {
      const bad = preflight("file.read", path);
      if (bad !== undefined) return bad;
      const denied = await gate("file.read", path);
      if (denied !== undefined) return denied;
      const result = await config.delegate.file.read(path, opts);
      pass("file.read", path);
      return result;
    },
    async list(path) {
      const bad = preflight("file.list", path);
      if (bad !== undefined) return bad;
      const denied = await gate("file.list", path);
      if (denied !== undefined) return denied;
      const result = await config.delegate.file.list(path);
      pass("file.list", path);
      return result;
    },
    async write(path, content, opts) {
      const bad = preflight("file.write", path);
      if (bad !== undefined) return bad;
      const denied = await gate("file.write", path);
      if (denied !== undefined) return denied;
      const result = await config.delegate.file.write(path, content, opts);
      pass("file.write", path);
      return result;
    },
    async applyPatch(patches, opts) {
      const operation = opts?.operation ?? "file.applyPatch";
      for (const patch of patches) {
        const bad = preflight(operation, patch.path);
        if (bad !== undefined) return bad;
      }
      const denied = await gate(operation, patches[0]?.path);
      if (denied !== undefined) return denied;
      const result = await config.delegate.file.applyPatch(patches, opts);
      pass(operation, patches[0]?.path);
      return result;
    },
  };

  const shell: StructuredShellBackend = {
    async start(request) {
      const denied = await gate("shell.start", request.cwd);
      if (denied !== undefined) return denied;
      const result = await config.delegate.shell.start(request);
      pass("shell.start", request.cwd);
      return result;
    },
  };

  return { file, shell };
}

export interface StructuredRecordingOptions {
  readonly runExitCode?: number;
  readonly runThrow?: Error;
  readonly allowedDirectories?: readonly string[];
}

/** 测试用结构化后端：记录每次 run/结构化操作，可注入失败验证宿主零变化。 */
export function createStructuredRecordingBackend(options: StructuredRecordingOptions = {}): StructuredExecutionBackend {
  const evidenceLog: BackendEvidence[] = [];
  const local = createLocalSafeBackend({ allowedDirectories: options.allowedDirectories ?? [] });
  const operations: OperationCapabilityReport = {
    operations: {
      "file.read": "active",
      "file.list": "active",
      "file.write": "active",
      "file.applyPatch": "active",
      "shell.start": "active",
      "session.open": "active",
      cleanup: "active",
    },
  };
  const gated = createGatedStructuredBackend({
    name: "structured-recording-backend",
    operations,
    evidence: evidenceLog,
    authorize: async (operation, target) => {
      void target;
      if (options.runThrow !== undefined) throw options.runThrow;
      const exitCode = options.runExitCode ?? 0;
      if (exitCode !== 0) return `exit ${exitCode}`;
      return undefined;
    },
    delegate: local,
    allowedDirectories: options.allowedDirectories ?? [],
  });
  return createStructuredExecutionBackend({
    name: "structured-recording-backend",
    capabilities: {
      isolation: "active",
      seccomp: "active",
      fsConfinement: "active",
      auditSink: "active",
      egressDefaultDeny: "active",
    },
    executor: () => ({ exitCode: options.runExitCode ?? 0, stdout: "", stderr: "", isolated: null }),
    operations,
    file: gated.file,
    shell: gated.shell,
    evidence: () => [...evidenceLog],
  });
}

/** 按 profile 构造后端：local-safe 收敛、local-full 真实可执行；沙箱档位明确失败关闭。 */
export function createProfileBackend(
  profile: Parameters<typeof profileSupport>[0],
  options: { readonly platform?: NodePlatform; readonly allowedDirectories?: readonly string[] } = {}
): StructuredExecutionBackend {
  const support = profileSupport(profile, options.platform ?? currentPlatform());
  if (profile === "local-safe") {
    return createLocalSafeBackend({ allowedDirectories: options.allowedDirectories ?? [] });
  }
  if (profile === "local-full") {
    return createLocalFullBackend({ allowedDirectories: options.allowedDirectories ?? [] });
  }
  return createStructuredExecutionBackend({
    name: profile,
    capabilities: { ...support.capabilities },
    executor: () => ({ exitCode: 1, stdout: "", stderr: support.reason ?? "UNSUPPORTED", isolated: null }),
    operations: support.operations,
    evidence: () => [],
  });
}
