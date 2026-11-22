import type { ColorToken } from "./theme";
import { diffLines } from "./components/diff-view";
import type { TimelineToolEntry } from "./timeline";

/**
 * 工具执行呈现：把工具名 / 参数 / 结果投影成带语义色的行。
 *
 * 目标是复刻目标终端 UI 的逐工具呈现：
 * - read/write/edit/ls/grep/find/bash 各自不同的标题与结果形态；
 * - 预览默认折叠，提示键位与隐藏行数；
 * - 失败行用错误色，耗时用暗淡色单独成行。
 */

export interface StyledRun {
  readonly text: string;
  readonly token?: ColorToken;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export type StyledLine = readonly StyledRun[];

export interface ToolViewOptions {
  readonly cwd?: string;
  readonly expanded?: boolean;
  /** 展开提示里显示的键名，默认 Ctrl+O。 */
  readonly expandKey?: string;
  /** 折叠预览行数，默认 10。 */
  readonly previewLines?: number;
}

export interface ToolView {
  readonly header: StyledLine;
  /** 正文（不含标题），已按折叠策略裁剪。 */
  readonly body: readonly StyledLine[];
  /** 分隔的空行标记：为 true 时正文前渲染一行空白。 */
  readonly bodySpaced: boolean;
  /** 耗时 / 错误摘要等尾注。 */
  readonly note?: StyledLine;
}

const DEFAULT_PREVIEW_LINES = 10;
const BASH_PREVIEW_LINES = 5;

function run(text: string, token?: ColorToken, extras?: Partial<StyledRun>): StyledRun {
  return { text, token, ...extras };
}

function line(...runs: StyledRun[]): StyledLine {
  return runs;
}

function textLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "").split("\n");
}

function trimTrailingEmpty(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").length === 0) end -= 1;
  return lines.slice(0, end).map((item) => item.replace(/\t/g, "  "));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** 把工具参数里的路径投影为相对 cwd 的短路径。 */
export function displayPath(rawPath: string | undefined, cwd: string | undefined): string {
  if (rawPath === undefined) return "";
  if (cwd === undefined || cwd.length === 0) return rawPath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized === normalizedCwd) return ".";
  const prefix = `${normalizedCwd}/`;
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  return normalized;
}

function pathOf(args: unknown): string | undefined {
  const record = asRecord(args);
  return firstString(record, ["path", "file_path", "filePath", "dir", "directory"]);
}

function commandOf(args: unknown): string | undefined {
  const record = asRecord(args);
  return firstString(record, ["command", "cmd"]);
}

function patternOf(args: unknown): string | undefined {
  const record = asRecord(args);
  return firstString(record, ["pattern", "query", "search"]);
}

/** 结果对象 → 可展示文本。兼容内置工具的 {ok, content/stdout/entries/matches/paths} 形状。 */
export function resultToText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (record === undefined) return String(result);
  if (record.ok === false) {
    // 失败时保留摘要与有界的两路输出，便于展开后查看诊断。
    const error = firstString(record, ["error", "reason", "message"]);
    const streams = [record.stdout, record.stderr]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n");
    if (error !== undefined && streams.length > 0) return `${error}\n${streams}`;
    if (error !== undefined) return error;
    if (streams.length > 0) return streams;
  }
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const entry = asRecord(block);
        if (entry === undefined) return typeof block === "string" ? block : "";
        if (typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (typeof record.stdout === "string" || typeof record.stderr === "string") {
    return [record.stdout, record.stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  }
  if (Array.isArray(record.entries)) {
    return record.entries
      .map((entry) => {
        const item = asRecord(entry);
        if (item === undefined) return String(entry);
        const name = typeof item.name === "string" ? item.name : String(entry);
        return item.type === "directory" ? `${name}/` : name;
      })
      .join("\n");
  }
  if (Array.isArray(record.matches)) {
    return record.matches
      .map((entry) => {
        const item = asRecord(entry);
        if (item === undefined) return String(entry);
        const lineNo = typeof item.line === "number" ? item.line : undefined;
        const text = typeof item.text === "string" ? item.text : "";
        return lineNo === undefined ? text : `${lineNo}: ${text}`;
      })
      .join("\n");
  }
  if (Array.isArray(record.paths)) {
    return record.paths.map((item) => String(item).replace(/\\/g, "/")).join("\n");
  }
  if (typeof record.bytes === "number") return `Wrote ${record.bytes} bytes`;
  if (typeof record.replacements === "number") {
    return record.replacements === 0 ? "No replacements" : `${record.replacements} replacement${record.replacements === 1 ? "" : "s"}`;
  }
  // 不可序列化（BigInt/循环引用等）时降级为占位字符串，保证工具卡渲染不抛错。
  try {
    const text = JSON.stringify(record);
    if (typeof text === "string") return text;
  } catch {
    // 落到下面的占位。
  }
  return "[unserializable tool result]";
}

function clipped(lines: readonly string[], max: number, keep: "start" | "end", hint: string):
  | { readonly shown: readonly string[]; readonly hidden: number; readonly hintText: string }
  | undefined {
  const cleaned = trimTrailingEmpty(lines);
  if (cleaned.length === 0) return undefined;
  if (cleaned.length <= max) return { shown: cleaned, hidden: 0, hintText: "" };
  const hidden = cleaned.length - max;
  const shown = keep === "start" ? cleaned.slice(0, max) : cleaned.slice(hidden);
  const where = keep === "start" ? "more lines" : "earlier lines";
  return { shown, hidden, hintText: `... (${hidden} ${where}, ${hint})` };
}

function bodyFromText(
  text: string,
  max: number,
  keep: "start" | "end",
  expandKey: string,
  token: ColorToken = "toolOutput",
): { readonly body: readonly StyledLine[]; readonly spaced: boolean } {
  const result = clipped(textLines(text), max, keep, `${expandKey} to expand`);
  if (result === undefined) return { body: [], spaced: false };
  const body: StyledLine[] = [];
  for (const item of result.shown) body.push(line(run(item, token)));
  if (result.hidden > 0) body.push(line(run(result.hintText, "muted")));
  return { body, spaced: true };
}

/** 文件内容预览（write 的调用预览 / read 的结果预览）。 */
function contentBody(
  text: string,
  max: number,
  expandKey: string,
  token: ColorToken = "toolOutput",
): { readonly body: readonly StyledLine[]; readonly spaced: boolean } {
  return bodyFromText(text, max, "start", expandKey, token);
}

function diffBody(
  before: string,
  after: string,
  max: number,
  expandKey: string,
): { readonly body: readonly StyledLine[]; readonly spaced: boolean } {
  const lines = diffLines(before, after).filter((entry) => entry.op !== "context" || entry.text.length > 0);
  if (lines.length === 0) return { body: [], spaced: false };
  const shown = lines.length <= max ? lines : lines.slice(0, max);
  const body: StyledLine[] = shown.map((entry) =>
    line(
      run(
        `${entry.op === "add" ? "+" : entry.op === "remove" ? "-" : " "} ${entry.text}`,
        entry.op === "add" ? "toolDiffAdded" : entry.op === "remove" ? "toolDiffRemoved" : "toolDiffContext",
      ),
    ),
  );
  const hidden = lines.length - shown.length;
  if (hidden > 0) body.push(line(run(`... (${hidden} more lines, ${expandKey} to expand)`, "muted")));
  return { body, spaced: true };
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `Took ${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `Took ${minutes}m ${rest}s`;
  return `Took ${Math.floor(minutes / 60)}h ${minutes % 60}m ${rest}s`;
}

function header(name: string, args: unknown, cwd: string | undefined): StyledLine {
  const path = displayPath(pathOf(args), cwd);
  const display = name.length > 0 ? name : "tool";
  switch (display) {
    case "read":
      return line(run("read", "toolTitle", { bold: true }), run(` ${path}`, "accent"));
    case "write":
      return line(run("write", "toolTitle", { bold: true }), run(` ${path}`, "accent"));
    case "edit":
      return line(run("edit", "toolTitle", { bold: true }), run(` ${path}`, "accent"));
    case "ls":
      return line(run("ls", "toolTitle", { bold: true }), run(` ${path.length > 0 ? path : "."}`, "accent"));
    case "grep": {
      const pattern = patternOf(args);
      return line(
        run("grep", "toolTitle", { bold: true }),
        run(pattern === undefined ? "" : ` "${pattern}"`, "warning"),
        run(path.length > 0 ? ` ${path}` : "", "accent"),
      );
    }
    case "find": {
      const pattern = patternOf(args);
      return line(
        run("find", "toolTitle", { bold: true }),
        run(pattern === undefined ? "" : ` "${pattern}"`, "warning"),
        run(path.length > 0 ? ` ${path}` : "", "accent"),
      );
    }
    case "bash":
    case "powershell": {
      const command = commandOf(args);
      return line(run(`${display} ${command ?? "..."}`, "toolTitle", { bold: true }));
    }
    default: {
      const summary = summarizeArgs(args);
      return line(
        run(display, "toolTitle", { bold: true }),
        run(summary.length > 0 ? ` ${summary}` : "", "muted"),
      );
    }
  }
}

function summarizeArgs(args: unknown): string {
  const record = asRecord(args);
  if (record === undefined) return args === undefined ? "" : String(args);
  const parts = Object.entries(record)
    .slice(0, 4)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const clippedText = text === undefined ? "" : text.length > 40 ? `${text.slice(0, 37)}...` : text;
      return `${key}=${clippedText}`;
    });
  return parts.join(" ");
}

/** 生成一条工具执行的完整呈现。 */
export function presentTool(entry: TimelineToolEntry, options: ToolViewOptions = {}): ToolView {
  const cwd = options.cwd;
  const expanded = options.expanded === true;
  const expandKey = options.expandKey ?? "ctrl+o";
  const max = options.previewLines ?? DEFAULT_PREVIEW_LINES;
  const head = header(entry.name, entry.args, cwd);
  const args = asRecord(entry.args);
  const name = entry.name;

  let body: readonly StyledLine[] = [];
  let spaced = false;

  const push = (next: { readonly body: readonly StyledLine[]; readonly spaced: boolean }): void => {
    if (next.body.length === 0) return;
    body = next.body;
    spaced = next.spaced;
  };

  if (name === "write") {
    const content = firstString(args, ["content"]);
    if (content !== undefined) push(contentBody(content, expanded ? Number.MAX_SAFE_INTEGER : max, expandKey));
  } else if (name === "edit") {
    const before = firstString(args, ["from", "oldText", "old_string"]);
    const after = firstString(args, ["to", "newText", "new_string"]);
    if (before !== undefined && after !== undefined) {
      // 目标 UI 的 edit 在折叠状态也展示完整 diff。
      push(diffBody(before, after, Number.MAX_SAFE_INTEGER, expandKey));
    }
  }

  if (body.length === 0 && (name !== "read" || entry.status === "error")) {
    const partial = entry.partialResult === undefined ? "" : resultToText(entry.partialResult);
    const final = entry.result === undefined ? "" : resultToText(entry.result);
    const output = final.length > 0 ? final : partial;
    if (output.length > 0) {
      if (name === "bash" || name === "powershell") {
        push(bodyFromText(output, expanded ? Number.MAX_SAFE_INTEGER : BASH_PREVIEW_LINES, "end", expandKey));
      } else if (name === "grep") {
        push(bodyFromText(output, expanded ? Number.MAX_SAFE_INTEGER : 15, "start", expandKey));
      } else if (name === "find" || name === "ls") {
        push(bodyFromText(output, expanded ? Number.MAX_SAFE_INTEGER : 20, "start", expandKey));
      } else {
        push(bodyFromText(output, expanded ? Number.MAX_SAFE_INTEGER : max, "start", expandKey));
      }
    }
  }

  // read 折叠时不展示文件内容（避免长文件刷屏）；展开后显示全文。
  if (name === "read" && expanded) {
    const output = entry.result === undefined ? "" : resultToText(entry.result);
    if (output.length > 0) push(bodyFromText(output, Number.MAX_SAFE_INTEGER, "start", expandKey));
  }

  if (entry.status === "error" && (name === "write" || name === "edit") && body.length > 0) {
    const errorText = entry.result === undefined ? "" : resultToText(entry.result);
    if (errorText.length > 0) {
      const errorLines = trimTrailingEmpty(textLines(errorText)).slice(0, max);
      body = [...body, ...errorLines.map((item) => line(run(item, "error")))];
      spaced = true;
    }
  }

  const duration = formatDuration(entry.durationMs);
  const failed = entry.status === "error";
  const noteText = failed
    ? ["Failed", duration].filter((part): part is string => part !== undefined).join(" · ")
    : duration;
  const note = noteText === undefined ? undefined : line(run(noteText, failed ? "error" : "muted"));

  return { header: head, body, bodySpaced: spaced, note };
}
