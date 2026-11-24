import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
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

export interface LocalSafeBackendOptions {
  readonly allowedDirectories?: readonly string[];
  readonly platform?: NodePlatform;
  /** 故障注入：返回 true 时写入失败，用于回滚测试。 */
  readonly failWrite?: (path: string) => boolean;
  /** 进程生成注入，保证取消/输出测试不依赖真实平台语义。 */
  readonly spawn?: SpawnImpl;
  readonly now?: () => number;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  cancel(): Promise<void>;
  readonly exited: Promise<number>;
}

export type OutputSink = (kind: "stdout" | "stderr", chunk: string) => void;

export type SpawnImpl = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
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
  const allowed = options.allowedDirectories ?? [];
  const platform = options.platform ?? currentPlatform();
  const now = options.now ?? Date.now;
  const evidenceLog: BackendEvidence[] = [];
  const support = profileSupport("local-safe", platform);
  const operations: OperationCapabilityReport = support.operations;

  const record = (operation: OperationName, target: string | undefined, ok: boolean): BackendEvidence => {
    const entry: BackendEvidence = { backend: "local-safe", operation, target, at: now(), ok };
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

  const openChecked = (path: string, write: boolean, opts: OpenOptions = {}): { fd: number; stat: FileStatSnapshot; target: string } => {
    const target = confinedPath(path, allowed);
    assertNofollow(resolve(path), target);
    if (opts.nofollow === false) throw new Error("NOFOLLOW_CANNOT_BE_DISABLED");
    const flags = write
      ? safeFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT)
      : safeFlags(fsConstants.O_RDONLY);
    const fd = openSync(target, flags, 0o666);
    try {
      const stat = snapshot(fstatSync(fd));
      if (!stat.isFile) throw new Error("UNSUPPORTED_FILE_TYPE: only regular files are allowed");
      if (!matchesExpected(stat, opts.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
      return { fd, stat, target };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  };

  const writeChecked = (path: string, content: string, opts: OpenOptions = {}) => {
    const target = confinedPath(path, allowed);
    assertNofollow(resolve(path), target);
    if (opts.nofollow === false) throw new Error("NOFOLLOW_CANNOT_BE_DISABLED");
    if (options.failWrite?.(target) === true) throw new Error("INJECTED_WRITE_FAILURE");
    if (opts.expected !== undefined) {
      if (!existsSync(target)) throw new Error("EXPECTED_STAT_MISMATCH: file does not exist");
      if (!matchesExpected(snapshot(lstatSync(target)), opts.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
    }
    const flags = safeFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT);
    const fd = openSync(target, flags, 0o666);
    try {
      const before = snapshot(fstatSync(fd));
      if (!before.isFile) throw new Error("UNSUPPORTED_FILE_TYPE: only regular files are allowed");
      if (!matchesExpected(before, opts.expected)) throw new Error("EXPECTED_STAT_MISMATCH");
      ftruncateSync(fd, 0);
      writeSync(fd, content, 0, "utf8");
      fsyncSync(fd);
      return { before, after: snapshot(fstatSync(fd)) };
    } finally {
      closeSync(fd);
    }
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
        const child = spawnImpl(request.argv, { cwd: request.cwd, env }, (kind, chunk) => {
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
        });
        const onAbort = (): void => {
          void child.cancel();
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        const handle: ProcessHandle = {
          pid: child.pid,
          async cancel() {
            await child.cancel();
          },
          exited: child.exited.then((exitCode): ShellResult => ({
            exitCode,
            stdout,
            stderr,
            terminated: truncated,
            truncated,
          })),
        };
        return success("shell.start", request.cwd, handle);
      } catch (error) {
        return failure("shell.start", request.cwd, shellErrorCode(error), String((error as Error).message));
      }
    },
  };

  return createStructuredExecutionBackend({
    name: "local-safe",
    capabilities: { ...support.capabilities } as Capabilities,
    executor: () => ({ exitCode: 1, stdout: "", stderr: "SHELL_UNSUPPORTED_ON_LOCAL_SAFE", isolated: null }),
    operations,
    file,
    shell,
    evidence: () => [...evidenceLog],
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
  if (message.includes("EXPECTED_STAT")) return "EXPECTED_STAT_MISMATCH";
  if (message.includes("FILE_TYPE")) return "UNSUPPORTED_FILE_TYPE";
  if (message.includes("INJECTED_WRITE")) return "INJECTED_WRITE_FAILURE";
  return "FILE_OPERATION_FAILED";
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
  return createStructuredExecutionBackend({
    name: backend.name,
    capabilities: { ...backend.capabilities() },
    executor: (command, runOptions) => backend.run(command, runOptions),
    operations,
    file: gated.file,
    shell: gated.shell,
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

/** 按 profile 构造后端：只有 local-safe 暴露真实文件边界；其他档位明确失败关闭。 */
export function createProfileBackend(
  profile: Parameters<typeof profileSupport>[0],
  options: { readonly platform?: NodePlatform; readonly allowedDirectories?: readonly string[] } = {}
): StructuredExecutionBackend {
  const support = profileSupport(profile, options.platform ?? currentPlatform());
  if (profile === "local-safe") {
    return createLocalSafeBackend({ allowedDirectories: options.allowedDirectories ?? [] });
  }
  return createStructuredExecutionBackend({
    name: profile,
    capabilities: { ...support.capabilities },
    executor: () => ({ exitCode: 1, stdout: "", stderr: support.reason ?? "UNSUPPORTED", isolated: null }),
    operations: support.operations,
    evidence: () => [],
  });
}
