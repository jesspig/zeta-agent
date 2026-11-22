import type { AgentStreamFn, AgentMessage, AgentStreamRequest } from "../facade";
import { encodeImage, type ImageSource } from "./image";

export interface ImageStreamConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

interface TextPart {
  readonly type: "text";
  readonly text: string;
}
interface ImagePart {
  readonly type: "image";
  readonly source: ImageSource;
}
interface ImageUrlPart {
  readonly type: "image_url";
  readonly image_url?: { readonly url?: string };
}
type ContentPart = TextPart | ImagePart | ImageUrlPart;

function isContentParts(content: unknown): content is readonly ContentPart[] {
  return Array.isArray(content);
}

interface ChatMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string; readonly image_url?: { readonly url: string } }[];
}

function toChatMessage(message: AgentMessage): ChatMessage {
  const role = message.role === "toolResult" ? "user" : message.role;
  if (isContentParts(message.content)) {
    const parts = message.content.map((part) => {
      if (part.type === "image") {
        return { type: "image_url", image_url: { url: encodeImage(part.source).dataUrl } };
      }
      if (part.type === "image_url") {
        // imageMessage helper 产出的原生格式，直接透传，避免图片被降成文本。
        return { type: "image_url", image_url: { url: part.image_url?.url ?? "" } };
      }
      return { type: "text", text: part.text };
    });
    return { role, content: parts };
  }
  return { role, content: String(message.content) };
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterableIterator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]" || payload.length === 0) continue;
        let parsed: { choices?: readonly { delta?: { content?: unknown } }[] };
        try {
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          continue;
        }
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk.length > 0) yield chunk;
      }
    }
  }
}

/** OpenAI 兼容流式函数，支持将多模态 content parts 编码进请求。 */
export function createImageAwareStreamFn(
  config: ImageStreamConfig,
  fetchImpl: typeof fetch = fetch
): AgentStreamFn {
  return async function* (request: AgentStreamRequest) {
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: request.messages.map(toChatMessage),
        stream: true,
      }),
    });
    if (!response.ok) throw new Error(`IMAGE_STREAM_HTTP_${response.status}`);
    if (response.body === null) throw new Error("IMAGE_STREAM_NO_BODY");
    yield* parseSse(response.body);
  };
}
