import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertEnforcement, type ExecutionBackend } from "@zeta-agent/security";
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
}

type Args = Readonly<Record<string, unknown>>;

function isInside(absolute: string, base: string): boolean {
  const relativePath = relative(base, absolute);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * 校验路径的实际目标仍处于允许目录内。
 * 词法 resolve/relative 只能挡住字面越界；目录联接或符号链接可让根内路径
 * 指向根外目标，因此对已存在的目标用 realpath 再校验一次。
 */
function assertConfined(path: string, allowed: readonly string[]): string {
  const absolute = resolve(path);
  const lexicalOk = allowed.some((directory) => isInside(absolute, resolve(directory)));
  if (!lexicalOk) {
    throw new Error(`TOOL_CONFINEMENT_VIOLATION: ${path} is outside allowed directories`);
  }
  // 路径不存在（如 write 的新文件）时，解析其最近存在祖先的 realpath，
  // 再补回缺失的路径段，从而仍能识别经目录联接逃逸的父目录。
  let realTarget: string;
  try {
    realTarget = realpathSync(absolute);
  } catch {
    let ancestor = absolute;
    const missingSegments: string[] = [];
    while (true) {
      try {
        const ancestorReal = realpathSync(ancestor);
        realTarget = join(ancestorReal, ...missingSegments.reverse());
        break;
      } catch {
        const next = dirname(ancestor);
        if (next === ancestor) return absolute;
        missingSegments.push(ancestor.slice(next.length + 1));
        ancestor = next;
      }
    }
  }
  const realOk = allowed.some((directory) => {
    const baseReal = realpathSync(resolve(directory));
    return isInside(realTarget, baseReal);
  });
  if (!realOk) {
    throw new Error(`TOOL_CONFINEMENT_VIOLATION: ${path} resolves outside allowed directories`);
  }
  return realTarget;
}

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

/** 文件变更与 bash/powershell 共用同一条后端执行边界：能力探测 + backend.run 登记。 */
async function authorizeFileMutation(
  backend: ExecutionBackend,
  guard: () => void,
  operation: "write" | "edit",
  path: string
): Promise<void> {
  guard();
  // 后端是命令执行抽象，结构化写入由工具层在 realpath 校验后执行；
  // 此处取 backend.run 的强制门禁语义，不以其 exitCode 判定写入结果。
  await backend.run({ argv: [`fs:${operation}`, path] });
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

function fileTools(
  allowed: readonly string[],
  backend: ExecutionBackend,
  guard: () => void
): ToolDefinition[] {
  return [
    {
      name: "read",
      label: "Read file",
      description: "读取受控目录内的文本文件，返回结构化内容。",
      parameters: parameters(pathParameter("要读取的文件绝对路径")),
      execute(input) {
        const args = isRecord(input) ? input : {};
        const path = assertConfined(requireString(args, "path"), allowed);
        return ok({ path, content: readFileSync(path, "utf8") });
      },
      renderCall: renderCall("read", ["path"]),
      renderResult,
    },
    {
      name: "write",
      label: "Write file",
      description: "在受控目录内写入文本文件，返回写入字节数。",
      parameters: parameters(
        pathParameter("要写入的文件绝对路径"),
        { name: "content", type: "string", description: "文件内容", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        const path = assertConfined(requireString(args, "path"), allowed);
        const content = requireString(args, "content");
        await authorizeFileMutation(backend, guard, "write", path);
        writeFileSync(path, content, "utf8");
        return ok({ path, bytes: Buffer.byteLength(content, "utf8") });
      },
      renderCall: renderCall("write", ["path", "content"]),
      renderResult,
    },
    {
      name: "edit",
      label: "Edit file",
      description: "在受控目录内对文本文件执行精确字符串替换。",
      parameters: parameters(
        pathParameter("要编辑的文件绝对路径"),
        { name: "from", type: "string", description: "被替换的原文本", required: true },
        { name: "to", type: "string", description: "替换后的文本", required: true }
      ),
      async execute(input) {
        const args = isRecord(input) ? input : {};
        const path = assertConfined(requireString(args, "path"), allowed);
        const from = requireString(args, "from");
        const to = requireString(args, "to");
        if (from.length === 0) throw new Error("TOOL_INPUT_INVALID: from must not be empty");
        await authorizeFileMutation(backend, guard, "edit", path);
        const original = readFileSync(path, "utf8");
        let replacements = 0;
        let cursor = 0;
        let updated = "";
        for (;;) {
          const index = original.indexOf(from, cursor);
          if (index < 0) {
            updated += original.slice(cursor);
            break;
          }
          updated += original.slice(cursor, index) + to;
          replacements += 1;
          cursor = index + from.length;
        }
        writeFileSync(path, updated, "utf8");
        return ok({ path, replacements });
      },
      renderCall: renderCall("edit", ["path", "from", "to"]),
      renderResult,
    },
    {
      name: "ls",
      label: "List directory",
      description: "列出受控目录内的条目（名称、类型、是否目录）。",
      parameters: parameters(pathParameter("要列出的目录绝对路径")),
      execute(input) {
        const args = isRecord(input) ? input : {};
        const path = assertConfined(requireString(args, "path"), allowed);
        const entries = readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
        return ok({ path, entries });
      },
      renderCall: renderCall("ls", ["path"]),
      renderResult,
    },
    {
      name: "grep",
      label: "Grep file",
      description: "在受控目录内的文件中搜索匹配行，返回行号与内容。",
      parameters: parameters(
        pathParameter("要搜索的文件绝对路径"),
        { name: "pattern", type: "string", description: "搜索文本", required: true }
      ),
      execute(input) {
        const args = isRecord(input) ? input : {};
        const path = assertConfined(requireString(args, "path"), allowed);
        const pattern = requireString(args, "pattern");
        const lines = readFileSync(path, "utf8").split(/\r?\n/);
        const matches: Array<{ line: number; text: string }> = [];
        lines.forEach((text, index) => {
          if (text.includes(pattern)) matches.push({ line: index + 1, text });
        });
        return ok({ path, pattern, matches });
      },
      renderCall: renderCall("grep", ["path", "pattern"]),
      renderResult,
    },
    {
      name: "find",
      label: "Find files",
      description: "在受控目录内按名称子串递归查找文件。",
      parameters: parameters(
        pathParameter("查找起始目录绝对路径"),
        { name: "pattern", type: "string", description: "文件名子串", required: true }
      ),
      execute(input) {
        const args = isRecord(input) ? input : {};
        const start = assertConfined(requireString(args, "path"), allowed);
        const pattern = requireString(args, "pattern");
        const paths: string[] = [];
        const visit = (directory: string): void => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.includes(pattern)) paths.push(full);
          }
        };
        visit(start);
        return ok({ path: start, pattern, paths });
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
  const files = fileTools(options.allowedDirectories, options.securityBackend, guard);
  return [
    ...files.slice(0, 1),
    ...commandTools(options.securityBackend, guard),
    ...files.slice(1),
  ];
}
