import { join } from "node:path";
import {
  assertEnforcement,
  buildShellEnv,
  createEgressPolicy,
  enforceOutputLimit,
  resolveStructuredBackend,
  type BackendEvidence,
  type EgressPolicy,
  type EgressTarget,
  type ExecutionBackend,
  type ListEntry,
  type ShellRequest,
  type StructuredExecutionBackend,
  type StructuredResult,
} from "@zeta-agent/security";
import type { PluginTool } from "../facade";

export interface ToolParameter {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  readonly required?: boolean;
}

export interface ToolDefinition extends PluginTool<Readonly<Record<string, unknown>>> {
  readonly label: string;
  readonly description: string;
  readonly parameters: readonly ToolParameter[];
  renderCall(args: Readonly<Record<string, unknown>>): string;
  renderResult(value: unknown): string;
}

/** read/grep/find 等工具的可配置资源上限；超限按 onLimit 截断或失败。 */
export interface ToolResourceLimits {
  /** 单次读取的最大 UTF-8 字节数（默认 1 MiB）。 */
  readonly maxReadBytes?: number;
  /** find 访问的最大条目数（默认 2000）。 */
  readonly maxEntries?: number;
  /** find 递归的最大深度（默认 32）。 */
  readonly maxDepth?: number;
  /** grep/find 的最大运行时间毫秒数（默认 5000）。 */
  readonly maxRuntimeMs?: number;
  /** grep 返回的最大匹配行数（默认 500）。 */
  readonly maxMatchLines?: number;
  /** 超限策略：truncate（默认，显式标记 truncated）或 fail。 */
  readonly onLimit?: "truncate" | "fail";
}

export const DEFAULT_TOOL_LIMITS: Readonly<Required<Omit<ToolResourceLimits, "onLimit">>> & {
  readonly onLimit: "truncate" | "fail";
} = Object.freeze({
  maxReadBytes: 1024 * 1024,
  maxEntries: 2000,
  maxDepth: 32,
  maxRuntimeMs: 5000,
  maxMatchLines: 500,
  onLimit: "truncate" as const,
});

function resolveLimits(limits: ToolResourceLimits | undefined) {
  return {
    maxReadBytes: limits?.maxReadBytes ?? DEFAULT_TOOL_LIMITS.maxReadBytes,
    maxEntries: limits?.maxEntries ?? DEFAULT_TOOL_LIMITS.maxEntries,
    maxDepth: limits?.maxDepth ?? DEFAULT_TOOL_LIMITS.maxDepth,
    maxRuntimeMs: limits?.maxRuntimeMs ?? DEFAULT_TOOL_LIMITS.maxRuntimeMs,
    maxMatchLines: limits?.maxMatchLines ?? DEFAULT_TOOL_LIMITS.maxMatchLines,
    onLimit: limits?.onLimit ?? DEFAULT_TOOL_LIMITS.onLimit,
  };
}

export interface BuiltinToolOptions {
  readonly securityBackend: ExecutionBackend;
  readonly allowedDirectories: readonly string[];
  /** 可选真实结构化后端；未注入时由 securityBackend 兼容解析得到。 */
  readonly structuredBackend?: StructuredExecutionBackend;
  readonly limits?: ToolResourceLimits;
  /** shell 命令的出站绑定；缺省默认拒绝。 */
  readonly egress?: EgressPolicy;
  readonly egressTarget?: EgressTarget;
  /** shell CPU/时间/输出上限；由 ShellRequest 透传，平台不支持时失败关闭。 */
  readonly maxOutputBytes?: number;
  readonly maxCpuMs?: number;
  readonly maxRuntimeMs?: number;
  /** 额外 deny 的 env 键与注入的伪凭证。 */
  readonly denyEnv?: readonly string[];
  readonly fakeCredentials?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

type Args = Readonly<Record<string, unknown>>;

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`TOOL_INPUT_INVALID: ${key} must be a string`);
  return value;
}

function optionalString(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function ok(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ok: true, ...extra };
}

/** 结构化结果失败统一投影为工具失败，保留 code 与后端名作为证据。 */
function backendFailure(
  result: { readonly code: string; readonly error: string },
  backend: string
): Record<string, unknown> {
  return { ok: false, error: `${result.code}: ${result.error}`, backend };
}

function unexpectedFailure(error: unknown, backend: string): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, backend };
}

function parameters(...definitions: ToolParameter[]): readonly ToolParameter[] {
  return definitions;
}

function pathParameter(description: string): ToolParameter {
  return { name: "path", type: "string", description, required: true };
}

function renderCall(name: string, keys: readonly string[]): (args: Args) => string {
  return (args) => {
    const parts = keys.filter((key) => args[key] !== undefined).map((key) => `${key}=${JSON.stringify(args[key])}`);
    return `${name}(${parts.join(", ")})`;
  };
}

function renderResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && value.ok === true) {
    if (typeof value.content === "string") return value.content;
    if (typeof value.stdout === "string") return value.stdout;
    return `ok (${Object.keys(value).join(", ")})`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceOf(result: StructuredResult<unknown>): BackendEvidence {
  return result.evidence;
}

function fileTools(
  allowed: readonly string[],
  structured: StructuredExecutionBackend,
  limitsInput?: ToolResourceLimits,
  now: () => number = Date.now
): ToolDefinition[] {
  const backend = structured.name;
  void allowed;
  const limits = resolveLimits(limitsInput);
  const limitContent = (content: string): { text: string; truncated: boolean } => {
    const limited = enforceOutputLimit(content, limits.maxReadBytes);
    return { text: limited.stdout, truncated: limited.truncated };
  };
  const limitFailure = (extra: string): Record<string, unknown> => ({
    ok: false,
    error: `RESOURCE_LIMIT_EXCEEDED: ${extra}`,
    backend,
  });
  return [
    {
      name: "read",
      label: "Read file",
      description: "经结构化后端读取受控目录内的文本文件，返回结构化内容。",
      parameters: parameters(pathParameter("要读取的文件绝对路径")),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const path = requireString(args, "path");
          const result = await structured.file.read(path);
          if (!result.ok) return backendFailure(result, backend);
          const { text, truncated } = limitContent(result.value.content);
          if (truncated && limits.onLimit === "fail") {
            return limitFailure(`read exceeds ${limits.maxReadBytes} bytes`);
          }
          return ok({
            path,
            content: text,
            backend,
            evidence: evidenceOf(result),
            ...(truncated ? { truncated: true } : {}),
          });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("read", ["path"]),
      renderResult,
    },
    {
      name: "write",
      label: "Write file",
      description: "经结构化后端在受控目录内写入文本文件，返回写入字节数。",
      parameters: parameters(
        pathParameter("要写入的文件绝对路径"),
        { name: "content", type: "string", description: "文件内容", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const path = requireString(args, "path");
          const content = requireString(args, "content");
          const result = await structured.file.write(path, content);
          if (!result.ok) return backendFailure(result, backend);
          return ok({ path, bytes: result.value.bytes, backend, evidence: evidenceOf(result) });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("write", ["path", "content"]),
      renderResult,
    },
    {
      name: "edit",
      label: "Edit file",
      description: "经结构化事务在受控目录内对文本文件执行精确字符串替换。",
      parameters: parameters(
        pathParameter("要编辑的文件绝对路径"),
        { name: "from", type: "string", description: "被替换的原文本", required: true },
        { name: "to", type: "string", description: "替换后的文本", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const path = requireString(args, "path");
          const from = requireString(args, "from");
          const to = requireString(args, "to");
          if (from.length === 0) throw new Error("TOOL_INPUT_INVALID: from must not be empty");
          const result = await structured.file.applyPatch([{ path, from, to }]);
          if (!result.ok) return backendFailure(result, backend);
          return ok({
            path,
            replacements: result.value.changes[0]?.replacements ?? 0,
            backend,
            evidence: evidenceOf(result),
          });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("edit", ["path", "from", "to"]),
      renderResult,
    },
    {
      name: "ls",
      label: "List directory",
      description: "经结构化后端列出受控目录内的条目（名称、类型）。",
      parameters: parameters(pathParameter("要列出的目录绝对路径")),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const path = requireString(args, "path");
          const result = await structured.file.list(path);
          if (!result.ok) return backendFailure(result, backend);
          const entries = result.value.entries.map((entry: ListEntry) => ({ name: entry.name, type: entry.type }));
          return ok({ path, entries, backend, evidence: evidenceOf(result) });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("ls", ["path"]),
      renderResult,
    },
    {
      name: "grep",
      label: "Grep file",
      description: "经结构化 file.read 读取文件并搜索匹配行；字节/行数/时间超限显式截断或失败。",
      parameters: parameters(
        pathParameter("要搜索的文件绝对路径"),
        { name: "pattern", type: "string", description: "搜索文本", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const path = requireString(args, "path");
          const pattern = requireString(args, "pattern");
          const result = await structured.file.read(path);
          if (!result.ok) return backendFailure(result, backend);
          const { text, truncated: contentTruncated } = limitContent(result.value.content);
          if (contentTruncated && limits.onLimit === "fail") {
            return limitFailure(`grep input exceeds ${limits.maxReadBytes} bytes`);
          }
          const started = now();
          const matches: Array<{ line: number; text: string }> = [];
          let matchTruncated = false;
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            if (matches.length >= limits.maxMatchLines || now() - started > limits.maxRuntimeMs) {
              matchTruncated = true;
              break;
            }
            const line = lines[index]!;
            if (line.includes(pattern)) matches.push({ line: index + 1, text: line });
          }
          if (matchTruncated && limits.onLimit === "fail") {
            return limitFailure(`grep exceeds ${limits.maxMatchLines} lines or ${limits.maxRuntimeMs}ms`);
          }
          const truncated = contentTruncated || matchTruncated;
          return ok({
            path,
            pattern,
            matches,
            backend,
            evidence: evidenceOf(result),
            ...(truncated ? { truncated: true } : {}),
          });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("grep", ["path", "pattern"]),
      renderResult,
    },
    {
      name: "find",
      label: "Find files",
      description: "经结构化 file.list 递归查找；深度/条目/时间超限显式截断或失败。",
      parameters: parameters(
        pathParameter("查找起始目录绝对路径"),
        { name: "pattern", type: "string", description: "文件名子串", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        try {
          const start = requireString(args, "path");
          const pattern = requireString(args, "pattern");
          const paths: string[] = [];
          const started = now();
          let truncated = false;
          const visit = async (directory: string, depth: number): Promise<void> => {
            if (truncated) return;
            if (depth > limits.maxDepth || paths.length >= limits.maxEntries || now() - started > limits.maxRuntimeMs) {
              truncated = true;
              return;
            }
            const result = await structured.file.list(directory);
            if (!result.ok) {
              paths.push(`ERROR:${directory}:${result.code}`);
              return;
            }
            for (const entry of result.value.entries) {
              if (truncated) break;
              if (paths.length >= limits.maxEntries || now() - started > limits.maxRuntimeMs) {
                truncated = true;
                break;
              }
              const full = join(directory, entry.name);
              if (entry.type === "directory") await visit(full, depth + 1);
              else if (entry.name.includes(pattern)) paths.push(full);
            }
          };
          await visit(start, 0);
          if (truncated && limits.onLimit === "fail") {
            return limitFailure(`find exceeds ${limits.maxEntries} entries / ${limits.maxDepth} depth / ${limits.maxRuntimeMs}ms`);
          }
          return ok({
            path: start,
            pattern,
            paths,
            backend,
            ...(truncated ? { truncated: true } : {}),
          });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("find", ["path", "pattern"]),
      renderResult,
    },
  ];
}

interface ShellToolConfig {
  readonly guard: () => void;
  readonly structured: StructuredExecutionBackend;
  readonly cwd: string;
  readonly egress?: EgressPolicy;
  readonly egressTarget?: EgressTarget;
  readonly maxOutputBytes?: number;
  readonly maxCpuMs?: number;
  readonly maxRuntimeMs?: number;
  readonly denyEnv?: readonly string[];
  readonly fakeCredentials?: Readonly<Record<string, string>>;
}

/**
 * bash/powershell 统一走 structured.shell.start(ShellRequest)，不再以
 * backend.run({argv:[flag,command]}) 绕过结构化执行边界。
 */
function commandTools(config: ShellToolConfig): ToolDefinition[] {
  const make = (name: string, label: string, flag: string): ToolDefinition => ({
    name,
    label,
    description: `经结构化 shell.start 执行命令（${name}）。`,
    parameters: parameters({
      name: "command",
      type: "string",
      description: "要执行的命令字符串",
      required: true,
    }),
    async execute(input, signal) {
      config.guard();
      const args = isRecord(input) ? input : {};
      const command = requireString(args, "command");
      const request: ShellRequest = {
        argv: [name, flag, command],
        cwd: config.cwd,
        env: buildShellEnv(process.env, {
          ...(config.denyEnv === undefined ? {} : { denyEnv: config.denyEnv }),
          ...(config.fakeCredentials === undefined ? {} : { fakeCredentials: config.fakeCredentials }),
        }),
        ...(config.denyEnv === undefined ? {} : { denyEnv: config.denyEnv }),
        ...(config.fakeCredentials === undefined ? {} : { fakeCredentials: config.fakeCredentials }),
        ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
        ...(config.maxCpuMs === undefined ? {} : { maxCpuMs: config.maxCpuMs }),
        ...(config.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: config.maxRuntimeMs }),
        ...(config.egress === undefined
          ? {}
          : {
              egress: {
                policy: config.egress,
                ...(config.egressTarget === undefined ? {} : { target: config.egressTarget }),
              },
            }),
        ...(signal === undefined ? {} : { signal }),
      };
      const started = await config.structured.shell.start(request);
      if (!started.ok) {
        return { ok: false, error: `${started.code}: ${started.error}`, backend: config.structured.name };
      }
      const finished = await started.value.exited;
      const termination = finished.termination ?? "confirmed";
      const base = {
        command,
        stdout: finished.stdout,
        stderr: finished.stderr,
        exitCode: finished.exitCode,
        termination,
      };
      if (termination === "unknown") {
        return {
          ok: false,
          error: `SHELL_TERMINATION_UNKNOWN: ${finished.reconciliation ?? "reconciliation required"}`,
          ...base,
          ...(finished.reconciliation === undefined ? {} : { reconciliation: finished.reconciliation }),
        };
      }
      if (finished.exitCode !== 0) {
        return { ok: false, error: `COMMAND_FAILED: exit ${finished.exitCode}`, ...base };
      }
      return ok(base);
    },
    renderCall: renderCall(name, ["command"]),
    renderResult,
  });

  return [make("bash", "Bash command", "-c"), make("powershell", "PowerShell command", "-Command")];
}

export function builtinToolDefinitions(options: BuiltinToolOptions): readonly ToolDefinition[] {
  const guard = (): void => assertEnforcement(options.securityBackend.capabilities());
  const structured =
    options.structuredBackend ?? resolveStructuredBackend(options.securityBackend, options.allowedDirectories);
  const files = fileTools(options.allowedDirectories, structured, options.limits, options.now);
  const cwd = options.allowedDirectories[0] ?? process.cwd();
  const egress =
    options.egress ?? (options.egressTarget === undefined ? undefined : createEgressPolicy());
  return [
    ...files.slice(0, 1),
    ...commandTools({
      guard,
      structured,
      cwd,
      ...(egress === undefined ? {} : { egress }),
      ...(options.egressTarget === undefined ? {} : { egressTarget: options.egressTarget }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.maxCpuMs === undefined ? {} : { maxCpuMs: options.maxCpuMs }),
      ...(options.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: options.maxRuntimeMs }),
      ...(options.denyEnv === undefined ? {} : { denyEnv: options.denyEnv }),
      ...(options.fakeCredentials === undefined ? {} : { fakeCredentials: options.fakeCredentials }),
    }),
    ...files.slice(1),
  ];
}
