import type { AgentMessage, AgentStreamChunk, AgentStreamFn, AgentStreamRequest, AgentToolSchema } from "../facade";

export interface OpenAiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 可选：以 OpenAI 兼容方式发送工具 schema。默认 true。 */
  readonly tools?: boolean;
}

interface ChatToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface ChatContentPart {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
}

interface ChatDelta {
  readonly content?: unknown;
  readonly reasoning_content?: unknown;
  readonly reasoning?: unknown;
  readonly thinking?: unknown;
  readonly reasoning_details?: unknown;
  readonly tool_calls?: readonly ChatToolCallDelta[];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const record = part as { readonly text?: unknown; readonly summary?: unknown; readonly thinking?: unknown };
          if (typeof record.text === "string") return record.text;
          if (typeof record.summary === "string") return record.summary;
          if (typeof record.thinking === "string") return record.thinking;
        }
        return "";
      })
      .join("");
  }
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly text?: unknown; readonly summary?: unknown; readonly content?: unknown };
    if (typeof record.text === "string") return record.text;
    if (typeof record.summary === "string") return record.summary;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

/** 兼容 DeepSeek/OpenRouter/OpenCode 等网关的多种推理字段。 */
function extractReasoning(delta: ChatDelta): string {
  return (
    asText(delta.reasoning_content) +
    asText(delta.reasoning) +
    asText(delta.thinking) +
    asText(delta.reasoning_details)
  );
}

interface ChatChunk {
  readonly choices?: readonly { readonly delta?: ChatDelta }[];
}

function toOpenAiParameters(schema: AgentToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of schema.parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      description: parameter.description,
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** 把内部消息映射为 OpenAI chat 消息；保留原生 tool_calls / tool 角色。 */
export function toOpenAiMessages(messages: readonly AgentMessage[]): readonly Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "toolResult") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "call-1",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      };
    }
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: typeof message.content === "string" && message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return {
      role: message.role,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    };
  });
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterableIterator<AgentStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>();

  const flushToolCalls = function* (): IterableIterator<AgentStreamChunk> {
    const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, call] of ordered) {
      if (call.name.length === 0) continue;
      yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
    }
    toolCalls.clear();
  };

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
        if (payload === "[DONE]") {
          yield* flushToolCalls();
          return;
        }
        if (payload.length === 0) continue;
        let parsed: ChatChunk;
        try {
          parsed = JSON.parse(payload) as ChatChunk;
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta === undefined) continue;
        const reasoning = extractReasoning(delta);
        if (reasoning.length > 0) yield { type: "reasoning", text: reasoning };
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield delta.content;
        } else if (Array.isArray(delta.content)) {
          for (const part of delta.content as readonly ChatContentPart[]) {
            if (typeof part === "string") {
              yield part;
            } else if (part.type === "thinking" || part.type === "reasoning") {
              const text = part.thinking ?? part.text ?? "";
              if (text.length > 0) yield { type: "reasoning", text };
            } else if (typeof part.text === "string" && part.text.length > 0) {
              yield part.text;
            }
          }
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? toolCalls.size;
          const current = toolCalls.get(index) ?? { name: "", arguments: "" };
          if (typeof call.id === "string" && call.id.length > 0) current.id = call.id;
          if (typeof call.function?.name === "string" && call.function.name.length > 0) {
            current.name = call.function.name;
          }
          if (typeof call.function?.arguments === "string") {
            current.arguments += call.function.arguments;
          }
          toolCalls.set(index, current);
        }
      }
    }
  }
  yield* flushToolCalls();
}

/**
 * OpenAI 兼容流式实现：文本、reasoning（DeepSeek/OpenRouter 等）与原生 tool_calls。
 * 工具调用在流结束后一次性产出，参数为累计的 JSON 字符串。
 */
export function createOpenAiStreamFn(
  config: OpenAiConfig,
  fetchImpl: typeof fetch = fetch
): AgentStreamFn {
  return async function* (request: AgentStreamRequest) {
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const tools = config.tools === false ? undefined : request.tools;
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOpenAiMessages(request.messages),
      stream: true,
      ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
    };
    if (tools !== undefined && tools.length > 0) {
      body.tools = tools.map((schema) => ({
        type: "function",
        function: {
          name: schema.name,
          description: schema.description,
          parameters: toOpenAiParameters(schema),
        },
      }));
      body.tool_choice = "auto";
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
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
