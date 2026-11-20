import type { AgentStreamFn, AgentStreamRequest } from "../facade";

export interface OpenAiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

interface ChatChunk {
  readonly choices?: readonly { readonly delta?: { readonly content?: unknown } }[];
}

function toChatMessage(message: AgentStreamRequest["messages"][number]): {
  role: string;
  content: string;
} {
  const role = message.role === "toolResult" ? "user" : message.role;
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
        if (payload === "[DONE]") return;
        if (payload.length === 0) continue;
        let parsed: ChatChunk;
        try {
          parsed = JSON.parse(payload) as ChatChunk;
        } catch {
          continue;
        }
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk.length > 0) yield chunk;
      }
    }
  }
}

export function createOpenAiStreamFn(
  config: OpenAiConfig,
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
    if (!response.ok) {
      const hint =
        response.status === 401
          ? "请检查 ZETA_API_KEY"
          : response.status === 429
            ? "请求被限流或额度不足，请稍后重试"
            : response.status === 404
              ? "请检查 ZETA_BASE_URL 与 ZETA_MODEL"
              : "";
      throw new Error(`OPENAI_HTTP_${response.status}${hint ? ` (${hint})` : ""}`);
    }
    if (response.body === null) {
      throw new Error("OPENAI_NO_BODY");
    }
    yield* parseSse(response.body);
  };
}
