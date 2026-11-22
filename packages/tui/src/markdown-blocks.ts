import type { ColorToken } from "./theme";
import type { StyledLine, StyledRun } from "./tool-view";

/**
 * 稳定 Markdown 投影：把常见 Markdown 语法投影为带语义色的行，
 * 不依赖 tree-sitter，流式增量安全（半截语法按普通文本渲染）。
 */

interface InlineStyle {
  readonly token?: ColorToken;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

function pushRun(target: StyledRun[], text: string, style: InlineStyle): void {
  if (text.length === 0) return;
  target.push({ text, ...style });
}

const INLINE_PATTERN =
  /(`[^`]*`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))|(~~[^~]+~~)/g;

/** 行内 Markdown → 多个样式 run。 */
export function parseInline(source: string, base: InlineStyle = {}): readonly StyledRun[] {
  const runs: StyledRun[] = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) pushRun(runs, source.slice(cursor, index), base);
    const token = match[0];
    if (token.startsWith("`")) {
      pushRun(runs, token.slice(1, -1), { token: "mdCode" });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      for (const inner of parseInline(token.slice(2, -2), { ...base, bold: true })) runs.push(inner);
    } else if (token.startsWith("~~")) {
      for (const inner of parseInline(token.slice(2, -2), base)) runs.push({ ...inner, token: inner.token ?? base.token });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      for (const inner of parseInline(token.slice(1, -1), { ...base, italic: true })) runs.push(inner);
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch !== null) {
        pushRun(runs, linkMatch[1] ?? "", { token: "mdLink", bold: base.bold });
        pushRun(runs, ` (${linkMatch[2] ?? ""})`, { token: "mdLinkUrl" });
      } else {
        pushRun(runs, token, base);
      }
    } else {
      pushRun(runs, token, base);
    }
    cursor = index + token.length;
  }
  if (cursor < source.length) pushRun(runs, source.slice(cursor), base);
  return runs;
}

function headingLevel(line: string): { readonly level: number; readonly text: string } | undefined {
  const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
  if (match === null) return undefined;
  return { level: (match[1] ?? "#").length, text: match[2] ?? "" };
}

function bullet(line: string): { readonly indent: number; readonly marker: string; readonly text: string } | undefined {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (match === null) return undefined;
  const rawMarker = match[2] ?? "-";
  const marker = /^\d/.test(rawMarker) ? rawMarker.replace(")", ".") : "•";
  return { indent: (match[1] ?? "").length, marker, text: match[3] ?? "" };
}

/** Markdown 源码 → 样式化行。 */
export function parseMarkdown(source: string): readonly StyledLine[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "").split("\n");
  const output: StyledLine[] = [];
  let inCode = false;
  let codeLang = "";

  for (const rawLine of lines) {
    const fence = /^\s*```(.*)$/.exec(rawLine) ?? /^\s*~~~(.*)$/.exec(rawLine);
    if (fence !== null) {
      if (inCode) {
        inCode = false;
        codeLang = "";
      } else {
        inCode = true;
        codeLang = (fence[1] ?? "").trim();
        if (codeLang.length > 0) {
          output.push([{ text: codeLang, token: "mdCodeBlockBorder", italic: true }]);
        }
      }
      continue;
    }

    if (inCode) {
      output.push([{ text: rawLine.replace(/\t/g, "  "), token: "mdCodeBlock" }]);
      continue;
    }

    if (rawLine.trim().length === 0) {
      output.push([]);
      continue;
    }

    const heading = headingLevel(rawLine);
    if (heading !== undefined) {
      output.push([
        ...parseInline(heading.text, { token: "mdHeading", bold: true }),
      ]);
      continue;
    }

    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(rawLine)) {
      output.push([{ text: "─".repeat(24), token: "mdRule" }]);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(rawLine);
    if (quote !== null) {
      output.push([
        { text: "│ ", token: "quoteBorder" },
        ...parseInline(quote[1] ?? "", { token: "quoteText" }),
      ]);
      continue;
    }

    const item = bullet(rawLine);
    if (item !== undefined) {
      const indent = " ".repeat(Math.min(item.indent, 8));
      output.push([
        { text: `${indent}${item.marker} `, token: "mdListBullet" },
        ...parseInline(item.text),
      ]);
      continue;
    }

    output.push([...parseInline(rawLine)]);
  }

  return trimBlankEdges(output);
}

function trimBlankEdges(lines: readonly StyledLine[]): readonly StyledLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start]?.length ?? 0) === 0) start += 1;
  while (end > start && (lines[end - 1]?.length ?? 0) === 0) end -= 1;
  return lines.slice(start, end);
}

/** 纯文本投影（无样式），供非渲染路径与测试使用。 */
export function markdownToPlain(source: string): string {
  return parseMarkdown(source)
    .map((line) => line.map((run) => run.text).join(""))
    .join("\n");
}
