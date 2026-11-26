import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Disposer } from "@zeta-agent/framework";
import type { AgentEvent } from "../runtime/agent";
import type { AgentPlugin, PluginContribution, PluginToolParameter } from "./types";
import {
  createPluginSource,
  pluginSourceDigest,
  verifyPluginSourceDigest,
  DEFAULT_EVALUATE_LIMITS,
  type EvaluateLimits,
  type PluginSource,
} from "./plugin-source";
import { pluginSystemSandbox, type PluginSystemSandbox } from "./sandbox-support";

export {
  createPluginSource,
  pluginSourceDigest,
  verifyPluginSourceDigest,
  DEFAULT_EVALUATE_LIMITS,
  pluginSystemSandbox,
};
export type { EvaluateLimits, PluginSource, PluginSystemSandbox };

// ---------------------------------------------------------------------------
// 序列化贡献：只含纯数据 + handler 占位 id，绝不含函数或宿主对象引用。
// ---------------------------------------------------------------------------

export interface SerializedMeta {
  readonly order?: number;
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
  readonly replaceable?: boolean;
  readonly required?: boolean;
  readonly source?: string;
  readonly digest?: string;
}

export interface SerializedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: readonly PluginToolParameter[];
  readonly handlerId: string;
}

export type SerializedContribution =
  | ({ readonly kind: "tool"; readonly tool: SerializedTool } & SerializedMeta)
  | ({ readonly kind: "hook"; readonly event: string; readonly handlerId: string } & SerializedMeta)
  | ({ readonly kind: "section"; readonly text: string } & SerializedMeta)
  | ({ readonly kind: "wrap"; readonly name: string; readonly handlerId: string } & SerializedMeta)
  | ({ readonly kind: "task"; readonly name: string; readonly handlerId: string } & SerializedMeta)
  | ({ readonly kind: "service"; readonly name: string; readonly value?: unknown } & SerializedMeta);

export interface InvokeResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  /** 子进程终止不确定时按 T-12 对账语义返回；调用方不得普通重试。 */
  readonly reconciliation?: string;
}

export interface InvocationRequest {
  readonly plugin: string;
  readonly handlerId: string;
  readonly event: unknown;
  readonly trusted: boolean;
  readonly kind: string;
}

/** 宿主侧调用门禁：由集成方注入以复用 T-11 出站 / T-12 文件边界。 */
export interface InvocationGate {
  check(request: InvocationRequest): void | Promise<void>;
}

export interface CapabilityRecord {
  readonly kind: string;
  readonly name?: string;
  readonly event?: string;
  readonly handlerId?: string;
  readonly executionPath: "child-vm-ipc" | "host-data";
  readonly executableInHost: boolean;
  readonly reason: string;
}

/** 能力报告与实际执行路径一一对应，untrusted 不得伪装成宿主可执行或伪装成功。 */
export interface IsolationReport {
  readonly topLevelExecution: "child-vm";
  readonly digestVerified: true;
  readonly termination: "confirmed" | "unknown";
  readonly reconciliation?: string;
  readonly capabilities: readonly CapabilityRecord[];
  /** 系统级沙箱事实；无 seccomp/jail 时如实 unsupported，不伪装 active。 */
  readonly systemSandbox: PluginSystemSandbox;
}

export interface IsolatedPlugin extends AgentPlugin {
  readonly isolated: true;
  readonly digest: string;
  readonly report: IsolationReport;
  readonly closed: boolean;
  readonly installRegistered: boolean;
  /** install() 触发的子进程调用；供调用方等待对账，不改变 install(): Disposer 契约。 */
  readonly installPromise?: Promise<InvokeResult>;
  /** 受限代理：只能经 IPC 调用子进程 handler，且经过 InvocationGate。 */
  invoke(handlerId: string, event?: unknown, signal?: AbortSignal): Promise<InvokeResult>;
  /** 宿主集成点：注入复用 T-11 出站 / T-12 文件边界的调用门禁。 */
  setInvocationGate(gate: InvocationGate | undefined): void;
  /** 明确终止子进程；返回 T-12 风格对账状态。 */
  terminate(): Promise<{ termination: "confirmed" | "unknown"; reconciliation?: string }>;
}

// ---------------------------------------------------------------------------
// 子进程适配：可注入以便测试，默认使用 node:child_process.spawn（Windows 可用）。
// ---------------------------------------------------------------------------

export interface EvalChild {
  readonly pid?: number;
  readonly stdin: { write(data: string): void; end(): void };
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr?: AsyncIterable<string | Uint8Array> | null;
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type EvalSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
) => EvalChild;

const defaultSpawn: EvalSpawn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return {
    get pid() {
      return child.pid;
    },
    stdin: {
      write(data: string) {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      end() {
        if (!child.stdin.destroyed) child.stdin.end();
      },
    },
    stdout: child.stdout as AsyncIterable<Uint8Array>,
    stderr: child.stderr as AsyncIterable<Uint8Array>,
    exited: new Promise<number | null>((done) => {
      child.once("exit", (code) => done(code));
      child.once("error", () => done(null));
    }),
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出：视为已确认终止。
      }
    },
  };
};

function workerPath(): string {
  const candidates = [
    (() => {
      try {
        return fileURLToPath(new URL("./eval-worker.mjs", import.meta.url));
      } catch {
        return "";
      }
    })(),
    resolve(process.cwd(), "packages/agent-framework/src/plugins/eval-worker.mjs"),
  ];
  const found = candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
  if (found === undefined) throw new Error("PLUGIN_WORKER_NOT_FOUND");
  return found;
}

async function* linesFrom(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function drain(stream: AsyncIterable<string | Uint8Array> | null | undefined): Promise<void> {
  if (stream === null || stream === undefined) return;
  for await (const _chunk of stream) {
    // 只消费，避免子进程 stderr 背压；诊断信息由结果消息承载。
  }
}

class PluginEvaluationError extends Error {
  readonly code: string;
  readonly termination: "confirmed" | "unknown";
  readonly reconciliation?: string;

  constructor(code: string, message: string, termination: "confirmed" | "unknown", reconciliation?: string) {
    super(message);
    this.name = "PluginEvaluationError";
    this.code = code;
    this.termination = termination;
    if (reconciliation !== undefined) this.reconciliation = reconciliation;
  }
}

export { PluginEvaluationError };

function reconciliation(reason: string): string {
  return `PLUGIN_EVAL_TERMINATION_UNKNOWN:${reason};DO_NOT_RETRY`;
}

interface ResultMessage {
  readonly t: "result";
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly name?: string;
  readonly contributions?: readonly SerializedContribution[];
  readonly installRegistered?: boolean;
  readonly handlerIds?: readonly string[];
  readonly digest?: string;
}

interface InvokeMessage {
  readonly t: "invokeResult";
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

function isResultMessage(value: unknown): value is ResultMessage {
  return typeof value === "object" && value !== null && (value as { t?: unknown }).t === "result";
}

function isInvokeMessage(value: unknown): value is InvokeMessage {
  return typeof value === "object" && value !== null && (value as { t?: unknown }).t === "invokeResult";
}

function safeInput(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 受限宿主代理：可溶性贡献 → PluginContribution；可执行项全部走 IPC。
// ---------------------------------------------------------------------------

function metaOf(item: SerializedMeta) {
  return {
    ...(item.order === undefined ? {} : { order: item.order }),
    ...(item.priority === undefined ? {} : { priority: item.priority }),
    ...(item.dependsOn === undefined ? {} : { dependsOn: item.dependsOn }),
    ...(item.replaceable === undefined ? {} : { replaceable: item.replaceable }),
    ...(item.required === undefined ? {} : { required: item.required }),
    ...(item.source === undefined ? {} : { source: item.source }),
    ...(item.digest === undefined ? {} : { digest: item.digest }),
  };
}

function makeReport(
  trusted: boolean,
  contributions: readonly SerializedContribution[],
  installRegistered: boolean,
  termination: "confirmed" | "unknown",
  reconciliationValue?: string
): IsolationReport {
  const capabilities: CapabilityRecord[] = [];
  for (const item of contributions) {
    const executable = item.kind !== "section" && item.kind !== "service";
    const allowed = trusted && executable;
    const descriptorHandlerId = item.kind === "tool" ? item.tool.handlerId : "handlerId" in item ? item.handlerId : undefined;
    capabilities.push({
      kind: item.kind,
      ...("name" in item ? { name: item.name } : {}),
      ...("event" in item ? { event: item.event } : {}),
      ...(descriptorHandlerId === undefined ? {} : { handlerId: descriptorHandlerId }),
      executionPath: allowed ? "child-vm-ipc" : "host-data",
      executableInHost: allowed,
      reason: allowed
        ? "TRUSTED_IPC_PROXY"
        : executable
          ? "UNTRUSTED_HOST_EXECUTION_BLOCKED"
          : "DATA_ONLY_CONTRIBUTION",
    });
  }
  if (installRegistered) {
    capabilities.push({
      kind: "install",
      executionPath: trusted ? "child-vm-ipc" : "host-data",
      executableInHost: trusted,
      reason: trusted ? "TRUSTED_IPC_PROXY" : "UNTRUSTED_HOST_EXECUTION_BLOCKED",
    });
  }
  return {
    topLevelExecution: "child-vm",
    digestVerified: true,
    termination,
    ...(reconciliationValue === undefined ? {} : { reconciliation: reconciliationValue }),
    capabilities,
    systemSandbox: pluginSystemSandbox(),
  };
}

class IsolatedPluginImpl implements IsolatedPlugin {
  readonly kind = "AgentPlugin" as const;
  readonly isolated = true as const;
  readonly name: string;
  readonly contributions: readonly PluginContribution[];
  readonly digest: string;
  readonly trusted: boolean;
  readonly source: string | undefined;
  readonly capabilities: readonly string[] | undefined;
  readonly version: string | undefined;
  readonly installRegistered: boolean;

  private readonly serialized: readonly SerializedContribution[];
  private readonly child: EvalChild;
  private readonly lines: AsyncGenerator<string>;
  private gate: InvocationGate | undefined;
  private readonly invokeTimeoutMs: number;
  private readonly terminateGraceMs: number;
  private readonly pending = new Map<string, (message: InvokeMessage) => void>();
  private _closed = false;
  private sequence = 0;
  private reading = false;
  private termination: "confirmed" | "unknown" = "confirmed";
  private reconciliationValue: string | undefined;
  installPromise: Promise<InvokeResult> | undefined;

  constructor(options: {
    readonly source: PluginSource;
    readonly result: ResultMessage;
    readonly child: EvalChild;
    readonly lines: AsyncGenerator<string>;
    readonly gate: InvocationGate | undefined;
    readonly invokeTimeoutMs: number;
    readonly terminateGraceMs: number;
  }) {
    this.name = options.result.name ?? options.source.name;
    this.digest = options.source.digest;
    this.trusted = options.source.trusted;
    this.source = options.source.origin;
    this.capabilities = options.source.capabilities;
    this.version = options.source.version;
    this.installRegistered = options.result.installRegistered === true;
    this.child = options.child;
    this.lines = options.lines;
    this.gate = options.gate;
    this.invokeTimeoutMs = options.invokeTimeoutMs;
    this.terminateGraceMs = options.terminateGraceMs;
    this.serialized = options.result.contributions ?? [];
    this.contributions = this.serialized.map((item) => this.translate(item));
  }

  get closed(): boolean {
    return this._closed;
  }

  /** 报告随终止状态动态更新，始终与实际执行路径一致。 */
  get report(): IsolationReport {
    return makeReport(
      this.trusted,
      this.serialized,
      this.installRegistered,
      this.termination,
      this.reconciliationValue
    );
  }

  private translate(item: SerializedContribution): PluginContribution {
    const meta = metaOf(item);
    switch (item.kind) {
      case "section":
        return { kind: "section", text: item.text, ...meta } as PluginContribution;
      case "service":
        return {
          kind: "service",
          name: item.name,
          ...(item.value === undefined ? {} : { value: item.value }),
          ...meta,
        } as PluginContribution;
      case "tool":
        return {
          kind: "tool",
          ...meta,
          tool: {
            name: item.tool.name,
            ...(item.tool.description === undefined ? {} : { description: item.tool.description }),
            parameters: item.tool.parameters,
            execute: (input: unknown, signal?: AbortSignal) =>
              this.invoke(item.tool.handlerId, input, signal).then((result) => {
                if (!result.ok) throw new Error(result.error ?? "PLUGIN_TOOL_INVOKE_FAILED");
                return result.value;
              }),
          },
        } as PluginContribution;
      case "hook":
        return {
          kind: "hook",
          event: item.event,
          ...meta,
          // hook 链要求同步 handler；IPC 结果只做失败日志，不回灌宿主返回值。
          handler: (event: AgentEvent) => {
            void this.invoke(item.handlerId, safeInput(event)).catch(() => undefined);
          },
        } as PluginContribution;
      case "wrap":
        return {
          kind: "wrap",
          name: item.name,
          ...meta,
          handler: (event: AgentEvent, signal?: AbortSignal) =>
            this.invoke(item.handlerId, safeInput(event), signal).then(() => undefined),
        } as PluginContribution;
      case "task":
        return {
          kind: "task",
          name: item.name,
          ...meta,
          handler: () => this.invoke(item.handlerId, undefined).then(() => undefined),
        } as PluginContribution;
    }
  }

  setInvocationGate(gate: InvocationGate | undefined): void {
    this.gate = gate;
  }

  install(): Disposer {
    if (this.installRegistered && this.trusted) {
      this.installPromise = this.invoke("install", undefined);
    }
    return () => {
      void this.terminate();
    };
  }

  async invoke(handlerId: string, event?: unknown, signal?: AbortSignal): Promise<InvokeResult> {
    if (this._closed) {
      return { ok: false, error: "PLUGIN_EVAL_CLOSED", ...(this.reconciliationValue ? { reconciliation: this.reconciliationValue } : {}) };
    }
    if (this.gate !== undefined) {
      try {
        await this.gate.check({
          plugin: this.name,
          handlerId,
          event,
          trusted: this.trusted,
          kind: handlerId.split(":")[0] ?? "unknown",
        });
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
      }
    }
    const id = `invoke:${(this.sequence += 1)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const response = new Promise<InvokeMessage>((done) => this.pending.set(id, done));
      this.child.stdin.write(
        `${JSON.stringify({ t: "invoke", id, handlerId, event: safeInput(event) })}\n`
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PLUGIN_INVOKE_TIMEOUT")), this.invokeTimeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) reject(new Error("PLUGIN_INVOKE_ABORTED"));
        else if (signal !== undefined) {
          abortListener = () => reject(new Error("PLUGIN_INVOKE_ABORTED"));
          signal.addEventListener("abort", abortListener, { once: true });
        }
      });
      const message = await Promise.race([response, timeout, aborted]);
      return {
        ok: message.ok,
        ...(message.value === undefined ? {} : { value: safeInput(message.value) }),
        ...(message.error === undefined ? {} : { error: message.error }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const state = await this.terminate();
      // 超时/取消无法确认 handler 是否已完成副作用：按 T-12 记 unknown，禁止普通重试。
      if (reason === "PLUGIN_INVOKE_TIMEOUT" || reason === "PLUGIN_INVOKE_ABORTED") {
        this.setTermination("unknown", reason === "PLUGIN_INVOKE_ABORTED" ? "cancel" : "timeout");
      }
      const reconciliationValue = this.report.reconciliation ?? state.reconciliation;
      return {
        ok: false,
        error: reason,
        ...(reconciliationValue === undefined ? {} : { reconciliation: reconciliationValue }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", abortListener);
      }
      this.pending.delete(id);
    }
  }

  async terminate(): Promise<{ termination: "confirmed" | "unknown"; reconciliation?: string }> {
    if (this._closed) {
      return {
        termination: this.termination,
        ...(this.reconciliationValue === undefined ? {} : { reconciliation: this.reconciliationValue }),
      };
    }
    this._closed = true;
    try {
      this.child.stdin.write(`${JSON.stringify({ t: "stop" })}\n`);
      this.child.stdin.end();
    } catch {
      // 管道已关闭：继续按退出状态对账。
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"unknown">((done) => {
      timer = setTimeout(() => done("unknown"), this.terminateGraceMs);
    });
    const exited: Promise<"confirmed" | "unknown"> = this.child.exited.then(
      () => "confirmed" as const,
      () => "unknown" as const
    );
    const outcome = await Promise.race<"confirmed" | "unknown">([exited, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "unknown") {
      this.child.kill();
      this.termination = "unknown";
      this.reconciliationValue = reconciliation("cancel");
    }
    for (const done of [...this.pending.values()]) {
      done({ t: "invokeResult", id: "", ok: false, error: "PLUGIN_EVAL_CLOSED" });
    }
    this.pending.clear();
    return {
      termination: this.termination,
      ...(this.reconciliationValue === undefined ? {} : { reconciliation: this.reconciliationValue }),
    };
  }

  /** 启动后台行读取；由 evaluatePluginSource 在构造后调用。 */
  startReading(): void {
    if (this.reading) return;
    this.reading = true;
    void (async () => {
      for await (const line of this.lines) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (isInvokeMessage(message)) {
          const done = this.pending.get(message.id);
          if (done !== undefined) {
            this.pending.delete(message.id);
            done(message);
            continue;
          }
        }
      }
      this._closed = true;
      for (const done of [...this.pending.values()]) {
        done({ t: "invokeResult", id: "", ok: false, error: "PLUGIN_EVAL_CLOSED" });
      }
      this.pending.clear();
    })();
  }

  setTermination(termination: "confirmed" | "unknown", reason?: string): void {
    this.termination = termination;
    if (termination === "unknown") {
      this.reconciliationValue = reconciliation(reason ?? "cancel");
    }
  }

}

export interface EvaluateOptions {
  readonly signal?: AbortSignal;
  readonly invocationGate?: InvocationGate;
  readonly spawnImpl?: EvalSpawn;
  readonly execPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly terminateGraceMs?: number;
}

/**
 * 隔离求值入口：
 * 1. 宿主先做 SHA-256 digest 校验，不匹配立即拒绝；
 * 2. 子进程（process.execPath + 随包 worker）内用受限 vm 求值顶层代码；
 * 3. 返回只含序列化贡献的受限宿主代理；函数执行一律 IPC。
 */
export async function evaluatePluginSource(
  source: PluginSource,
  options: EvaluateOptions = {}
): Promise<IsolatedPlugin> {
  if (source?.kind !== "PluginSource") throw new Error("PLUGIN_SOURCE_INVALID");
  const sourceLimits = { ...DEFAULT_EVALUATE_LIMITS, ...(source.limits ?? {}) };
  // 校验在宿主进行且早于任何子进程创建：格式/长度/不匹配立即拒绝。
  verifyPluginSourceDigest(source, sourceLimits);

  const timeoutMs = sourceLimits.timeoutMs!;
  const invokeTimeoutMs = sourceLimits.invokeTimeoutMs!;
  const terminateGraceMs = options.terminateGraceMs ?? 200;
  const memoryFlag = `--max-old-space-size=${sourceLimits.maxOldSpaceMb!}`;
  const execPath = options.execPath ?? process.execPath;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const child = spawnImpl(execPath, [memoryFlag, workerPath()], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  void drain(child.stderr);
  const lines = linesFrom(child.stdout);
  const pluginHolder: { current?: IsolatedPluginImpl } = {};
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    pluginHolder.current?.setTermination("unknown", "cancel");
    child.kill();
  };
  if (options.signal?.aborted === true) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    child.stdin.write(
      `${JSON.stringify({
        t: "init",
        name: source.name,
        source: source.source,
        digest: source.digest,
        limits: {
          timeoutMs,
          invokeTimeoutMs,
          maxOutputBytes: sourceLimits.maxOutputBytes,
          maxContributions: sourceLimits.maxContributions,
        },
      })}\n`
    );
    const raw = await new Promise<string>((done, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abortListener = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new PluginEvaluationError("PLUGIN_EVAL_ABORTED", "plugin evaluation aborted", "unknown", reconciliation("cancel")));
      };
      timer = setTimeout(() => {
        reject(
          new PluginEvaluationError(
            "PLUGIN_EVAL_TIMEOUT",
            `plugin evaluation exceeded ${timeoutMs}ms`,
            "unknown",
            reconciliation("timeout")
          )
        );
      }, timeoutMs + terminateGraceMs);
      if (options.signal?.aborted === true) abortListener();
      else options.signal?.addEventListener("abort", abortListener, { once: true });
      void (async () => {
        try {
          const iterator = lines;
          const next = await iterator.next();
          if (next.done === true) throw new Error("PLUGIN_EVAL_EOF");
          done(next.value);
        } catch (error) {
          reject(error);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abortListener);
        }
      })();
    });

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      throw new PluginEvaluationError("PLUGIN_RESULT_INVALID", "result is not JSON", "confirmed");
    }
    if (!isResultMessage(message)) {
      throw new PluginEvaluationError("PLUGIN_RESULT_INVALID", "result shape invalid", "confirmed");
    }
    if (!message.ok) {
      const code = message.code ?? "PLUGIN_EVAL_FAILED";
      if (code === "PLUGIN_EVAL_TIMEOUT") {
        throw new PluginEvaluationError(code, message.error ?? "plugin evaluation timed out", "unknown", reconciliation("timeout"));
      }
      throw new PluginEvaluationError(code, message.error ?? "plugin evaluation failed", "confirmed");
    }
    const plugin = new IsolatedPluginImpl({
      source,
      result: message,
      child,
      lines,
      gate: options.invocationGate,
      invokeTimeoutMs,
      terminateGraceMs,
    });
    pluginHolder.current = plugin;
    plugin.startReading();
    return plugin;
  } catch (error) {
    child.kill();
    if (error instanceof PluginEvaluationError) throw error;
    const code = aborted ? "PLUGIN_EVAL_ABORTED" : (error as Error)?.message === "PLUGIN_EVAL_TIMEOUT"
      ? "PLUGIN_EVAL_TIMEOUT"
      : "PLUGIN_EVAL_FAILED";
    throw new PluginEvaluationError(
      code,
      error instanceof Error ? error.message : String(error),
      "unknown",
      reconciliation(aborted ? "cancel" : "eval")
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 宿主侧受限翻译：把隔离插件的贡献转成 PluginContribution。
 * 可执行项的 handler 已由 IsolatedPluginImpl 包装为 IPC 代理；调用方仍须按 trusted 收口。
 */
export function translateIsolatedContributions(plugin: IsolatedPlugin): readonly PluginContribution[] {
  return plugin.contributions;
}
