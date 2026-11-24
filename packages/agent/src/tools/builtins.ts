import { join } from "node:path";
import {
  assertEnforcement,
  resolveStructuredBackend,
  type BackendEvidence,
  type ExecutionBackend,
  type ListEntry,
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

export interface BuiltinToolOptions {
  readonly securityBackend: ExecutionBackend;
  readonly allowedDirectories: readonly string[];
  /** 可选真实结构化后端；未注入时由 securityBackend 兼容解析得到。 */
  readonly structuredBackend?: StructuredExecutionBackend;
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
  structured: StructuredExecutionBackend
): ToolDefinition[] {
  const backend = structured.name;
  void allowed;
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
          return ok({
            path,
            content: result.value.content,
            backend,
            evidence: evidenceOf(result),
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
      description: "经结构化后端读取文件并搜索匹配行，返回行号与内容。",
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
          const lines = result.value.content.split(/\r?\n/);
          const matches: Array<{ line: number; text: string }> = [];
          lines.forEach((text, index) => {
            if (text.includes(pattern)) matches.push({ line: index + 1, text });
          });
          return ok({ path, pattern, matches, backend, evidence: evidenceOf(result) });
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
      description: "经结构化后端递归列出受控目录内按名称子串匹配的文件。",
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
          const visit = async (directory: string): Promise<void> => {
            const result = await structured.file.list(directory);
            if (!result.ok) {
              paths.push(`ERROR:${directory}:${result.code}`);
              return;
            }
            for (const entry of result.value.entries) {
              const full = join(directory, entry.name);
              if (entry.type === "directory") await visit(full);
              else if (entry.name.includes(pattern)) paths.push(full);
            }
          };
          await visit(start);
          return ok({ path: start, pattern, paths, backend });
        } catch (error) {
          return unexpectedFailure(error, backend);
        }
      },
      renderCall: renderCall("find", ["path", "pattern"]),
      renderResult,
    },
  ];
}

function commandTools(backend: ExecutionBackend, guard: () => void): ToolDefinition[] {
  const make = (name: string, label: string, flag: string): ToolDefinition => ({
    name,
    label,
    description: `经安全后端执行命令（${name}）。`,
    parameters: parameters({
      name: "command",
      type: "string",
      description: "要执行的命令字符串",
      required: true,
    }),
    async execute(input) {
      guard();
      const args = isRecord(input) ? input : {};
      const command = requireString(args, "command");
      const result = await backend.run({ argv: [flag, command] });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: `COMMAND_FAILED: exit ${result.exitCode}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      }
      return ok({ command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
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
  const files = fileTools(options.allowedDirectories, structured);
  return [
    ...files.slice(0, 1),
    ...commandTools(options.securityBackend, guard),
    ...files.slice(1),
  ];
}
