import type { ResourceEntry, ResourceType } from "./registry";

export type ParserKind = ResourceType;

export interface ParsedResource {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, string>>;
}

export type ResourceParseErrorCode = "FORMAT_MISMATCH" | "INVALID_CONTENT";

/** 资源解析的 typed 失败；单条资源坏掉不影响清单里其它资源。 */
export class ResourceParseError extends Error {
  readonly code: ResourceParseErrorCode;
  readonly resourceId: string;

  constructor(code: ResourceParseErrorCode, resourceId: string, message: string) {
    super(message);
    this.name = "ResourceParseError";
    this.code = code;
    this.resourceId = resourceId;
  }
}

export interface ParserPlugin {
  readonly kind: ParserKind;
  /** 可选格式版本；格式不匹配时声明，不破坏其他解析器。 */
  readonly accepts?: readonly string[];
  /** 解析失败抛 ResourceParseError，由 parseResource 收敛为 typed fail。 */
  parse(source: string, entry: ResourceEntry): ParsedResource;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedResource }
  | { readonly ok: false; readonly error: ResourceParseError };

export function defineParserPlugin(plugin: ParserPlugin): ParserPlugin {
  return plugin;
}

/** 解析 frontmatter；未闭合或非法行抛 FORMAT_MISMATCH。无 frontmatter 返回空元数据。 */
function readFrontmatter(source: string, resourceId: string): { frontmatter: Record<string, string>; body: string } {
  if (!source.startsWith("---")) return { frontmatter: {}, body: source };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (match === null) {
    throw new ResourceParseError("FORMAT_MISMATCH", resourceId, "unterminated frontmatter");
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new ResourceParseError("FORMAT_MISMATCH", resourceId, `invalid frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body: source.slice(match[0].length) };
}

function markdownParser(kind: "skill" | "prompt" | "agents", requireName: boolean): ParserPlugin {
  return defineParserPlugin({
    kind,
    parse(source, entry) {
      const { frontmatter, body } = readFrontmatter(source, entry.id);
      const name = frontmatter.name ?? (kind === "prompt" ? entry.relativePath : "");
      if (requireName && name.length === 0) {
        throw new ResourceParseError("INVALID_CONTENT", entry.id, `${kind}: missing name`);
      }
      return {
        name,
        description: frontmatter.description ?? "",
        body,
        frontmatter,
      };
    },
  });
}

const themeParser = defineParserPlugin({
  kind: "theme",
  parse(source, entry) {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new ResourceParseError("INVALID_CONTENT", entry.id, "theme: invalid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ResourceParseError("INVALID_CONTENT", entry.id, "theme: expected an object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      throw new ResourceParseError("INVALID_CONTENT", entry.id, "theme: missing name");
    }
    return {
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      body: source,
      frontmatter: Object.fromEntries(
        Object.entries(record).filter(([, item]) => typeof item === "string")
      ) as Record<string, string>,
    };
  },
});

export const builtinParsers: readonly ParserPlugin[] = Object.freeze([
  markdownParser("skill", true),
  markdownParser("prompt", false),
  themeParser,
  markdownParser("agents", true),
]);

/**
 * 按资源类型选择解析器，并把任何抛错收敛成 typed ParseResult。
 * 不抛异常是刻意的：清单里的单条坏资源必须能被逐个识别，不拖垮其它资源。
 */
export function parseResource(
  entry: ResourceEntry,
  content: string,
  parsers: readonly ParserPlugin[] = builtinParsers
): ParseResult {
  const parser = parsers.find((item) => item.kind === entry.type);
  if (parser === undefined) {
    return { ok: false, error: new ResourceParseError("FORMAT_MISMATCH", entry.id, `no parser for ${entry.type}`) };
  }
  try {
    return { ok: true, value: parser.parse(content, entry) };
  } catch (error) {
    if (error instanceof ResourceParseError) return { ok: false, error };
    return {
      ok: false,
      error: new ResourceParseError("INVALID_CONTENT", entry.id, error instanceof Error ? error.message : String(error)),
    };
  }
}
