import type { McpCallResult } from "./client";

/** 二进制/资源落盘边界：URI 与数据由调用方提供，模块自身不碰宿主文件系统。 */
export interface McpResultSink {
  saveResource(uri: string, data: Uint8Array, mimeType?: string): string | Promise<string>;
}

export interface ProjectedMcpResult {
  /** 进入模型 transcript 的纯文本；永远不含二进制 blob 或结构化 JSON。 */
  readonly content: string;
  /** 供程序消费的原始结构数据，不进入模型 content。 */
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  /** 落盘资源引用：程序可按 ref 读取，模型只看到引用位。 */
  readonly details?: {
    readonly resources: readonly {
      readonly kind: string;
      readonly uri: string;
      readonly ref: string;
      readonly mimeType?: string;
    }[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  return new Uint8Array([...atob(value)].map((char) => char.charCodeAt(0)));
}

/** prompts/get 结果归一化为 MCP 工具结果；二进制块原样保留，交由 sink 门禁处理。 */
export function promptResultToCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) throw new Error("MCP_INVALID_PROMPT_RESULT");
  if (Array.isArray(result.content)) return { content: result.content as readonly unknown[] };
  if (!Array.isArray(result.messages)) return { content: [] };
  const content: unknown[] = [];
  for (const message of result.messages) {
    if (!isRecord(message)) continue;
    const raw = message.content;
    if (typeof raw === "string") {
      content.push({ type: "text", text: raw });
      continue;
    }
    if (!Array.isArray(raw)) continue;
    for (const part of raw) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "image" || part.type === "audio" || part.type === "resource") {
        content.push(part);
      } else {
        content.push({ type: "text", text: JSON.stringify(part) });
      }
    }
  }
  return { content };
}

/** resources/read 结果归一化：text 进模型，blob 必须经 sink 落盘。 */
export function resourceResultToCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) throw new Error("MCP_INVALID_RESOURCE_RESULT");
  if (Array.isArray(result.content)) return { content: result.content as readonly unknown[] };
  if (!Array.isArray(result.contents)) return { content: [] };
  const content = result.contents.map((raw) => {
    if (!isRecord(raw)) return { type: "text", text: "" };
    if (typeof raw.text === "string") return { type: "text", text: raw.text };
    if (typeof raw.blob === "string") {
      return {
        type: "resource",
        resource: {
          ...(typeof raw.uri === "string" ? { uri: raw.uri } : {}),
          ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
          blob: raw.blob,
        },
      };
    }
    return { type: "text", text: JSON.stringify(raw) };
  });
  return { content };
}

/**
 * MCP 工具结果的双投影：text 块进入模型 content；structuredContent 只留给程序；
 * image/audio/resource 等二进制内容必须经 sink 落盘，模型只看到不可伪造的 ref。
 */
export async function projectMcpResult(
  result: McpCallResult,
  options: { readonly sink?: McpResultSink } = {}
): Promise<ProjectedMcpResult> {
  const contents = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const saved: Array<{ kind: string; uri: string; ref: string; mimeType?: string }> = [];
  for (const item of contents) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
      continue;
    }
    if (item.type !== "image" && item.type !== "audio" && item.type !== "resource") continue;
    if (options.sink === undefined) throw new Error("MCP_RESOURCE_SINK_REQUIRED");
    const kind = String(item.type);
    const inner = isRecord(item.resource) ? item.resource : item;
    const uri = typeof inner.uri === "string" && inner.uri.length > 0
      ? inner.uri
      : `mcp:${kind}:${saved.length}`;
    const mimeType = typeof item.mimeType === "string" ? item.mimeType
      : typeof inner.mimeType === "string" ? inner.mimeType : undefined;
    const encoded = typeof item.data === "string" ? item.data
      : typeof inner.blob === "string" ? inner.blob
      : typeof inner.data === "string" ? inner.data : "";
    const data = decodeBase64(encoded);
    const ref = await options.sink.saveResource(uri, data, mimeType);
    saved.push({ kind, uri, ref, ...(mimeType === undefined ? {} : { mimeType }) });
  }
  const content = texts.join("\n");
  if (saved.length > 0) {
    const refs = saved.map((item) => `${item.kind}=${item.ref}`).join(", ");
    texts.push(`[MCP 资源已落盘: ${refs}]`);
  }
  return {
    content: texts.join("\n"),
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(saved.length === 0 ? {} : { details: { resources: saved } }),
  };
}
