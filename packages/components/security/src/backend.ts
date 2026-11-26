import type { Disposer } from "@zeta-agent/cordis/types";
import { isAbsolute as isAbsoluteLike, relative as relativeLike, resolve as resolveLike } from "node:path";
import type { EgressPolicy, EgressTarget } from "./egress";
import { isEgressAllowed } from "./egress";

export type LayerState = "active" | "degraded" | "unsupported" | "disabled";

export interface Capabilities {
  isolation: LayerState;
  seccomp: LayerState;
  fsConfinement: LayerState;
  auditSink: LayerState;
  egressDefaultDeny: LayerState;
}

export interface Command {
  readonly argv: readonly string[];
}

export interface RunOptions {
  readonly realm?: string;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolated: string | null;
}

export interface ExecutionBackend {
  readonly name: string;
  capabilities(): Capabilities;
  run(command: Command, options?: RunOptions): Promise<RunResult>;
  readonly dispose: Disposer;
}

/**
 * 结构化操作能力状态：每个操作独立声明，未声明的操作按 unsupported 处理。
 * 平台/隔离层不支持时只允许 unsupported/degraded，不允许把宿主直执行声明成 active。
 */
export type OperationName =
  | "file.read"
  | "file.list"
  | "file.write"
  | "file.applyPatch"
  | "shell.start"
  | "session.open"
  | "cleanup";

export const OperationNames: readonly OperationName[] = Object.freeze([
  "file.read",
  "file.list",
  "file.write",
  "file.applyPatch",
  "shell.start",
  "session.open",
  "cleanup",
]);

export interface OperationCapabilityReport {
  readonly operations: Readonly<Partial<Record<OperationName, LayerState>>>;
}

export function operationState(report: OperationCapabilityReport, operation: OperationName): LayerState {
  return report.operations[operation] ?? "unsupported";
}

export function assertOperation(report: OperationCapabilityReport, operation: OperationName): void {
  const state = operationState(report, operation);
  if (state === "degraded") {
    throw new Error(`OPERATION_UNAVAILABLE: ${operation} is degraded (CRITICAL_LAYER_DEGRADED)`);
  }
  if (state !== "active") throw new Error(`OPERATION_UNAVAILABLE: ${operation} is ${state}`);
}

/** 文件句柄快照：打开后用 fstat 校验目标，降低 path→open 之间的 TOCTOU 窗口。 */
export interface FileStatSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface ExpectedStat {
  readonly dev?: number;
  readonly ino?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
}

export interface OpenOptions {
  /** 拒绝跟随符号链接/reparse point；默认 true，调用方不可关闭。 */
  readonly nofollow?: boolean;
  /** 以非阻塞方式打开 FIFO/设备，避免打开阶段挂死；默认 true。 */
  readonly nonblock?: boolean;
  readonly expected?: ExpectedStat;
}

export interface OpenedFile {
  readonly path: string;
  readonly stat: FileStatSnapshot;
  readText(): Promise<{ readonly content: string; readonly stat: FileStatSnapshot }>;
  close(): Promise<void>;
}

export interface ListEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface BackendEvidence {
  readonly backend: string;
  readonly operation: OperationName;
  readonly target?: string;
  readonly at: number;
  readonly ok: boolean;
}

export type StructuredResult<T> =
  | { readonly ok: true; readonly value: T; readonly evidence: BackendEvidence }
  | { readonly ok: false; readonly error: string; readonly code: string; readonly evidence: BackendEvidence };

export interface FilePatch {
  readonly path: string;
  readonly from: string;
  readonly to: string;
  readonly expected?: ExpectedStat;
  /** 单文件能力要求；缺省 file.write。validate-all 阶段逐文件校验。 */
  readonly capability?: OperationName;
}

export interface ApplyPatchOptions {
  readonly dryRun?: boolean;
  readonly operation?: OperationName;
}

export interface PatchChange {
  readonly path: string;
  readonly replacements: number;
  readonly bytes: number;
  readonly before: FileStatSnapshot;
  readonly after: FileStatSnapshot;
}

export interface ApplyPatchResult {
  readonly applied: readonly string[];
  readonly rolledBack: readonly string[];
  readonly dryRun: boolean;
  readonly changes: readonly PatchChange[];
}

export interface StructuredFileBackend {
  open(path: string, options?: OpenOptions): Promise<StructuredResult<OpenedFile>>;
  read(path: string, options?: OpenOptions): Promise<StructuredResult<{ readonly content: string; readonly stat: FileStatSnapshot }>>;
  list(path: string): Promise<StructuredResult<{ readonly entries: readonly ListEntry[]; readonly stat: FileStatSnapshot }>>;
  write(path: string, content: string, options?: OpenOptions): Promise<StructuredResult<{ readonly bytes: number; readonly stat: FileStatSnapshot }>>;
  applyPatch(patches: readonly FilePatch[], options?: ApplyPatchOptions): Promise<StructuredResult<ApplyPatchResult>>;
}

export interface ShellRequest {
  readonly argv: readonly string[];
  /** 工作目录被约束在 allowedDirectories 内（workspace confine）。 */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly denyEnv?: readonly string[];
  readonly fakeCredentials?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  /** CPU 时间上限（毫秒）；平台无法强制时必须如实降级，不能声明 active。 */
  readonly maxCpuMs?: number;
  /** 墙钟运行时间上限（毫秒）；超时走独立 AbortController 并取消整个进程树。 */
  readonly maxRuntimeMs?: number;
  /** 取消后等待进程树退出确认的宽限期；超时仍未确认返回 unknown/reconciliation。 */
  readonly terminationGraceMs?: number;
  /** 数据面 egress 绑定：无 allow 规则即默认拒绝。 */
  readonly egress?: { readonly policy: EgressPolicy; readonly target?: EgressTarget };
  readonly signal?: AbortSignal;
}

/** 进程树终止确认状态：unknown 必须交给上层对账，禁止当作普通失败重试。 */
export type TerminationState = "confirmed" | "unknown";

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly terminated: boolean;
  readonly truncated: boolean;
  /** 默认 confirmed（自然退出）；取消/超时后未能确认则为 unknown。 */
  readonly termination?: TerminationState;
  /** 仅 termination=unknown 时出现，提示上层进入对账而不是重试。 */
  readonly reconciliation?: string;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<ShellResult>;
  /** 取消整个进程树（POSIX 进程组 / Windows taskkill /T）。 */
  cancel(): Promise<void>;
}

export interface StructuredShellBackend {
  start(request: ShellRequest): Promise<StructuredResult<ProcessHandle>>;
}

export interface StructuredExecutionBackend extends ExecutionBackend {
  readonly operations: OperationCapabilityReport;
  readonly file: StructuredFileBackend;
  readonly shell: StructuredShellBackend;
  evidence(): readonly BackendEvidence[];
}

export function isStructuredExecutionBackend(value: unknown): value is StructuredExecutionBackend {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StructuredExecutionBackend>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.capabilities === "function" &&
    typeof candidate.run === "function" &&
    typeof candidate.operations === "object" &&
    typeof candidate.file === "object" &&
    typeof candidate.shell === "object" &&
    typeof candidate.evidence === "function"
  );
}

export const CRITICAL_LAYERS = ["isolation", "seccomp", "fsConfinement"] as const;

export type CapabilityKey = keyof Capabilities;

export function criticalLayerFailures(capabilities: Capabilities): CapabilityKey[] {
  // 关键层只有 active 才代表强制已生效；degraded/unsupported/disabled 都必须失败关闭。
  return CRITICAL_LAYERS.filter((layer) => capabilities[layer] !== "active");
}

export function isCriticalLayerDegraded(capabilities: Capabilities): boolean {
  return criticalLayerFailures(capabilities).length > 0;
}

export function assertEnforcement(capabilities: Capabilities): void {
  const failures = criticalLayerFailures(capabilities);
  if (failures.length > 0) throw new Error(`CRITICAL_LAYER_DEGRADED: ${failures.join(",")}`);
}

/** 工作目录必须落在允许目录内；符号/reparse 解析交由底层句柄检查完成。 */
export function assertWorkspaceConfined(cwd: string, allowed: readonly string[]): void {
  // 延迟引入避免 backend 与平台实现互相依赖；此处仅做纯词法判断。
  const resolved = resolveLike(cwd);
  const inside = allowed.some((directory) => {
    const base = resolveLike(directory);
    const rel = relativeLike(base, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsoluteLike(rel));
  });
  if (!inside) throw new Error(`TOOL_CONFINEMENT_VIOLATION: cwd ${cwd} is outside allowed directories`);
}

export interface BackendConfig {
  readonly name: string;
  readonly capabilities: Capabilities;
  readonly executor: (command: Command, options?: RunOptions) => RunResult | Promise<RunResult>;
  readonly operations?: OperationCapabilityReport;
  readonly file?: StructuredFileBackend;
  readonly shell?: StructuredShellBackend;
  readonly evidence?: () => readonly BackendEvidence[];
}

export function createExecutionBackend(config: BackendConfig): ExecutionBackend {
  if (config.file !== undefined && config.shell !== undefined && config.operations !== undefined) {
    return createStructuredExecutionBackend(config);
  }
  return {
    name: config.name,
    capabilities: () => ({ ...config.capabilities }),
    async run(command: Command, options?: RunOptions): Promise<RunResult> {
      assertEnforcement(config.capabilities);
      return config.executor(command, options);
    },
    dispose: () => {},
  };
}

export function createStructuredExecutionBackend(config: BackendConfig): StructuredExecutionBackend {
  const operations = config.operations ?? { operations: {} };
  const evidence = config.evidence ?? (() => []);
  return {
    name: config.name,
    capabilities: () => ({ ...config.capabilities }),
    operations,
    file: config.file ?? failClosedFileBackend(config.name, operations, evidence),
    shell: config.shell ?? failClosedShellBackend(config.name, operations, evidence),
    evidence,
    async run(command: Command, options?: RunOptions): Promise<RunResult> {
      assertEnforcement(config.capabilities);
      return config.executor(command, options);
    },
    dispose: () => {},
  };
}

function failResult(
  backend: string,
  operation: OperationName,
  code: string,
  error: string,
  target?: string
): StructuredResult<never> {
  return {
    ok: false,
    code,
    error,
    evidence: { backend, operation, target, at: Date.now(), ok: false },
  };
}

function failClosedFileBackend(
  backend: string,
  operations: OperationCapabilityReport,
  evidence: () => readonly BackendEvidence[]
): StructuredFileBackend {
  const deny = async (operation: OperationName, target?: string) => {
    const record: BackendEvidence = { backend, operation, target, at: Date.now(), ok: false };
    void record; // 证据由外层 evidence() 统一汇总
    return failResult(backend, operation, "OPERATION_UNAVAILABLE", `${operation} is ${operationState(operations, operation)}`, target);
  };
  void evidence;
  return {
    open: (path) => deny("file.read", path),
    read: (path) => deny("file.read", path),
    list: (path) => deny("file.list", path),
    write: (path) => deny("file.write", path),
    applyPatch: () => deny("file.applyPatch"),
  };
}

function failClosedShellBackend(
  backend: string,
  operations: OperationCapabilityReport,
  evidence: () => readonly BackendEvidence[]
): StructuredShellBackend {
  void evidence;
  return {
    start: () => Promise.resolve(failResult(backend, "shell.start", "OPERATION_UNAVAILABLE", `shell.start is ${operationState(operations, "shell.start")}`)),
  };
}

/**
 * 未接入真实执行器时的占位能力：所有层都声明 unsupported。
 * 关键层只有 active 才算强制生效，因此能力探测会立刻判定为降级并失败关闭。
 */
export const UNCONNECTED_CAPABILITIES: Capabilities = Object.freeze({
  isolation: "unsupported",
  seccomp: "unsupported",
  fsConfinement: "unsupported",
  auditSink: "unsupported",
  egressDefaultDeny: "unsupported",
});

export interface UnconnectedBackendOptions {
  readonly name?: string;
  readonly reason?: string;
}

/** 占位后端：能力声明与实际一致（unsupported），不会把"未执行"伪装成成功。 */
export function createUnconnectedBackend(options: UnconnectedBackendOptions = {}): ExecutionBackend {
  const reason = options.reason ?? "NO_REAL_EXECUTION_BACKEND: 未配置真实隔离执行后端";
  return createExecutionBackend({
    name: options.name ?? "unconnected-placeholder",
    capabilities: UNCONNECTED_CAPABILITIES,
    executor: () => ({ exitCode: 1, stdout: "", stderr: reason, isolated: null }),
  });
}

/** 后端档位与平台支持矩阵。 */
export type BackendProfile = "local-safe" | "inproc-vm" | "bwrap-session" | "container" | "remote" | "microvm";

export const BACKEND_PROFILES: readonly BackendProfile[] = Object.freeze([
  "local-safe",
  "inproc-vm",
  "bwrap-session",
  "container",
  "remote",
  "microvm",
]);

export type NodePlatform =
  | "win32"
  | "linux"
  | "darwin"
  | "freebsd"
  | "openbsd"
  | "android"
  | "aix"
  | "sunos"
  | "cygwin"
  | "haiku";

export function currentPlatform(): NodePlatform {
  return process.platform as NodePlatform;
}

export interface ProfileSupport {
  readonly profile: BackendProfile;
  readonly platform: NodePlatform;
  readonly capabilities: Capabilities;
  readonly operations: OperationCapabilityReport;
  readonly reason: string | null;
}

const ALL_UNSUPPORTED: OperationCapabilityReport = Object.freeze({
  operations: Object.freeze({
    "file.read": "unsupported",
    "file.list": "unsupported",
    "file.write": "unsupported",
    "file.applyPatch": "unsupported",
    "shell.start": "unsupported",
    "session.open": "unsupported",
    cleanup: "unsupported",
  }) as Readonly<Partial<Record<OperationName, LayerState>>>,
});

/**
 * 沙箱档位在未接入真实执行器（bwrap/container/远端/microvm）时一律不声明 active。
 * Windows 下隔离/seccomp 明确 unsupported；其他平台为未接线的 degraded，同样失败关闭。
 */
export function profileSupport(profile: BackendProfile, platform: NodePlatform = currentPlatform()): ProfileSupport {
  if (profile === "local-safe") {
    return {
      profile,
      platform,
      capabilities: {
        isolation: "unsupported",
        seccomp: "unsupported",
        fsConfinement: "active",
        auditSink: "unsupported",
        egressDefaultDeny: "unsupported",
      },
      operations: {
        operations: {
          "file.read": "active",
          "file.list": "active",
          "file.write": "active",
          "file.applyPatch": "active",
          "shell.start": "unsupported",
          "session.open": "unsupported",
          cleanup: "active",
        },
      },
      reason: null,
    };
  }

  const isolation: LayerState = platform === "win32" ? "unsupported" : "degraded";
  const seccomp: LayerState = platform === "linux" ? "degraded" : "unsupported";
  return {
    profile,
    platform,
    capabilities: {
      isolation,
      seccomp,
      fsConfinement: platform === "win32" ? "unsupported" : "degraded",
      auditSink: "unsupported",
      egressDefaultDeny: "unsupported",
    },
    operations: ALL_UNSUPPORTED,
    reason: `${profile}: NO_REAL_SANDBOX_EXECUTOR@${platform}; fail-closed`,
  };
}

/** 供 shell backend 复用的 egress 断言：默认拒绝，平台 deny 优先。 */
export function assertShellEgress(policy: EgressPolicy, target: EgressTarget): void {
  if (!isEgressAllowed(policy, target)) throw new Error("EGRESS_DENIED");
}
