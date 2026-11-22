import type { AgentStreamChunk, AgentStreamFn, AgentStreamRequest } from "../facade";
import { PROVIDERS } from "./catalog.generated";
import { createModelRegistry } from "./registry";
import { createOpenAiStreamFn } from "./openai";
import { createOpenAiResponsesStreamFn } from "./openai-responses";

export interface ProviderConfig {
  /** provider id（如 openai / anthropic / groq）。 */
  readonly provider: string;
  /** 模型 id / 别名 / provider 侧模型名。 */
  readonly model: string;
  /** 显式 apiKey；缺省时按 PROVIDER_API_KEY_ENV / ZETA_API_KEY 读取环境变量。 */
  readonly apiKey?: string;
  /** 显式 baseUrl；缺省时用 catalog 的 defaultBaseUrl（可用 ZETA_BASE_URL 覆盖）。 */
  readonly baseUrl?: string;
}

interface ProviderInfo {
  readonly id: string;
  readonly defaultBaseUrl: string;
  readonly api: string;
}

const ENV_KEY_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  "openai-responses": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  bedrock: "BEDROCK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function resolveApiKey(provider: string, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const envName = ENV_KEY_BY_PROVIDER[provider] ?? "ZETA_API_KEY";
  const fromEnv = process.env[envName] ?? process.env.ZETA_API_KEY;
  if (fromEnv === undefined || fromEnv.length === 0) {
    throw new Error(`MISSING_API_KEY: 请设置 ${envName} 或 ZETA_API_KEY（凭据走环境变量，不入仓库）`);
  }
  return fromEnv;
}

function resolveBaseUrl(info: ProviderInfo, explicit?: string): string {
  const base = explicit ?? process.env.ZETA_BASE_URL ?? info.defaultBaseUrl;
  return base.replace(/\/+$/, "");
}

function toAnthropicContent(message: AgentStreamRequest["messages"][number]): unknown {
  if (message.role === "toolResult") {
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "call-1",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      },
    ];
  }
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const blocks: unknown[] = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.arguments) as unknown;
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
    }
    return blocks;
  }
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function toAnthropicTools(tools: AgentStreamRequest["tools"]): unknown[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        schema.parameters.map((parameter) => [
          parameter.name,
          { type: parameter.type, description: parameter.description },
        ]),
      ),
      required: schema.parameters.filter((parameter) => parameter.required === true).map((p) => p.name),
    },
  }));
}

interface AnthropicEvent {
  readonly type?: string;
  readonly index?: number;
  readonly content_block?: { readonly type?: string; readonly id?: string; readonly name?: string };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly partial_json?: string;
  };
}

async function* parseAnthropicSse(body: ReadableStream<Uint8Array>): AsyncIterableIterator<AgentStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks = new Map<number, { id?: string; name: string; json: string }>();

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
        if (payload.length === 0) continue;
        let event: AnthropicEvent;
        try {
          event = JSON.parse(payload) as AnthropicEvent;
        } catch {
          continue;
        }
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          blocks.set(event.index ?? blocks.size, {
            id: event.content_block.id,
            name: event.content_block.name ?? "",
            json: "",
          });
          continue;
        }
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield delta.text;
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "reasoning", text: delta.thinking };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const block = blocks.get(event.index ?? 0);
            if (block !== undefined) block.json += delta.partial_json;
          }
        }
        if (event.type === "content_block_stop") {
          const block = blocks.get(event.index ?? 0);
          if (block !== undefined && block.name.length > 0) {
            yield { type: "tool_call", id: block.id, name: block.name, arguments: block.json };
            blocks.delete(event.index ?? 0);
          }
        }
      }
    }
  }
}

interface GoogleEvent {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        readonly thought?: boolean;
        readonly functionCall?: { readonly name?: string; readonly args?: unknown };
      }[];
    };
  }[];
}

async function* parseGoogleSse(body: ReadableStream<Uint8Array>): AsyncIterableIterator<AgentStreamChunk> {
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
        if (payload.length === 0) continue;
        let event: GoogleEvent;
        try {
          event = JSON.parse(payload) as GoogleEvent;
        } catch {
          continue;
        }
        for (const candidate of event.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text.length > 0) {
              yield part.thought === true ? { type: "reasoning", text: part.text } : part.text;
            }
            if (part.functionCall !== undefined && typeof part.functionCall.name === "string") {
              yield {
                type: "tool_call",
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              };
            }
          }
        }
      }
    }
  }
}

function httpError(status: number, provider: string): Error {
  const hint =
    status === 401
      ? "请检查 API key 环境变量"
      : status === 429
        ? "请求被限流或额度不足，请稍后重试"
        : status === 404
          ? "请检查 baseUrl 与 model"
          : "";
  return new Error(`${provider.toUpperCase()}_HTTP_${status}${hint ? ` (${hint})` : ""}`);
}

export function createProviderStreamFn(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch
): AgentStreamFn {
  const info = PROVIDERS.find((entry) => entry.id === config.provider) as ProviderInfo | undefined;
  if (info === undefined) {
    throw new Error(`UNKNOWN_PROVIDER: ${config.provider}（可用：${PROVIDERS.map((p) => p.id).join(", ")}）`);
  }
  const registry = createModelRegistry();
  const model = registry.resolve(config.model);
  if (model === undefined) throw new Error(`UNKNOWN_MODEL: ${config.model}`);
  const apiKey = resolveApiKey(config.provider, config.apiKey);
  const baseUrl = resolveBaseUrl(info, config.baseUrl);
  const modelName = model.name;

  if (info.api === "openai-responses") {
    // OpenAI Responses API：/responses + instructions/input。
    return createOpenAiResponsesStreamFn({ baseUrl, apiKey, model: modelName }, fetchImpl);
  }
  if (info.api !== "anthropic-messages" && info.api !== "google-generate") {
    // openai-chat 与 bedrock-invoke 均通过 OpenAI 兼容 SSE 网关对接。
    return createOpenAiStreamFn({ baseUrl, apiKey, model: modelName }, fetchImpl);
  }

  return async function* (request: AgentStreamRequest) {
    let url: string;
    let init: RequestInit;
    let parse: (body: ReadableStream<Uint8Array>) => AsyncIterableIterator<AgentStreamChunk>;

    if (info.api === "anthropic-messages") {
      url = `${baseUrl}/messages`;
      const tools = toAnthropicTools(request.tools);
      init = {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 4096,
          stream: true,
          system: request.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"),
          messages: request.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: toAnthropicContent(m),
            })),
          ...(tools !== undefined ? { tools } : {}),
        }),
      };
      parse = parseAnthropicSse;
    } else {
      url = `${baseUrl}/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const tools =
        request.tools === undefined || request.tools.length === 0
          ? undefined
          : [
              {
                functionDeclarations: request.tools.map((schema) => ({
                  name: schema.name,
                  description: schema.description,
                  parameters: {
                    type: "OBJECT",
                    properties: Object.fromEntries(
                      schema.parameters.map((parameter) => [
                        parameter.name,
                        { type: parameter.type.toUpperCase(), description: parameter.description },
                      ]),
                    ),
                    required: schema.parameters.filter((p) => p.required === true).map((p) => p.name),
                  },
                })),
              },
            ];
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: request.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role === "assistant" ? "model" : m.role === "toolResult" ? "user" : m.role,
              parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
            })),
          ...(request.messages.some((m) => m.role === "system")
            ? {
                system_instruction: {
                  parts: [
                    {
                      text: request.messages
                        .filter((m) => m.role === "system")
                        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
                        .join("\n"),
                    },
                  ],
                },
              }
            : {}),
          ...(tools !== undefined ? { tools } : {}),
        }),
      };
      parse = parseGoogleSse;
    }

    const response = await fetchImpl(url, init);
    if (!response.ok) throw httpError(response.status, config.provider);
    if (response.body === null) throw new Error(`${config.provider.toUpperCase()}_NO_BODY`);
    yield* parse(response.body);
  };
}
