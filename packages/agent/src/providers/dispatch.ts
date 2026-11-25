import type { AgentStreamChunk, AgentStreamFn, AgentStreamRequest } from "../facade";
import {
  resolveAtBoundary,
  withCredentialFetch,
  type CredentialBoundaryRef,
  type CredentialVault,
  type Placeholder,
  type SecretBroker,
} from "@zeta-agent/security";
import { MODELS, PROVIDERS } from "./catalog.generated";
import { createModelRegistry } from "./registry";
import { createOpenAiStreamFn } from "./openai";
import { createOpenAiResponsesStreamFn } from "./openai-responses";
import { doneChunk, errorChunk, httpError, incompleteStreamChunk } from "./protocol";
import { withProviderRetry, type ProviderRetryOptions } from "./retry";

export interface ProviderConfig {
  /** provider id（如 openai / anthropic / groq）。 */
  readonly provider: string;
  /** 模型 id / 别名 / provider 侧模型名。 */
  readonly model: string;
  /** 显式 apiKey；缺省时按 PROVIDER_API_KEY_ENV / ZETA_API_KEY 读取环境变量。 */
  readonly apiKey?: string;
  /** 显式 baseUrl；缺省时用 catalog 的 defaultBaseUrl（可用 ZETA_BASE_URL 覆盖）。 */
  readonly baseUrl?: string;
  /**
   * 可选凭据注入：vault 与 broker 必须成对提供。
   * 成对提供时改用 issue() 占位符，真实 key 仅在 fetch 边界由 resolveAtBoundary 注入；
   * 不注入时保持原有从 env / 显式 apiKey 读取的行为不变。
   */
  readonly credentialVault?: CredentialVault;
  readonly secretBroker?: SecretBroker;
  /** 统一 credential boundary：优先级高于 vault 对，明文不进入 config。 */
  readonly credentialBoundary?: CredentialBoundaryRef;
  /** 显式启用时在输出前按中央策略重试；缺省保持既有单次请求行为。 */
  readonly retry?: ProviderRetryOptions | false;
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

/**
 * 请求边界包装：provider 构造请求时只接触占位符 token，真实凭据在 fetch 调用前一刻
 * 由 resolveAtBoundary 校验绑定并注入。broker 返回的 `key` / `x-goog-api-key` 视为 URL
 * 查询参数注入（Google 风格），其余键作为 header 注入。
 */
function withCredentialBoundary(
  vault: CredentialVault,
  placeholder: Placeholder,
  broker: SecretBroker,
  fetchImpl: typeof fetch
): typeof fetch {
  const boundary = ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const secrets = resolveAtBoundary(vault, placeholder, { url, method }, broker);
    const headers = new Headers(init?.headers);
    let nextInput: typeof input = input;
    for (const [name, value] of Object.entries(secrets)) {
      const lower = name.toLowerCase();
      if (lower === "key" || lower === "x-goog-api-key") {
        const parsed = new URL(url);
        parsed.searchParams.set("key", value);
        nextInput = parsed.toString();
      } else {
        headers.set(name, value);
      }
    }
    return fetchImpl(nextInput, { ...init, headers });
  }) as typeof fetch;
  // Bun 的 fetch 带 preconnect；原样转发，避免包装后类型/行为退化。
  const preconnect = (fetchImpl as { preconnect?: unknown }).preconnect;
  if (typeof preconnect === "function") (boundary as { preconnect?: unknown }).preconnect = preconnect;
  return boundary;
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

function googleResponseValue(content: unknown): unknown {
  if (content === undefined || content === null) return {};
  if (typeof content === "string") return { output: content };
  return content;
}

/**
 * Google 多轮工具协议：assistant.toolCalls → model functionCall parts，
 * toolResult → user functionResponse {id,name,response}。连续的并行结果合并到同一 content，
 * 每条结果独立成 part，避免 id 串位或丢失。
 */
function toGoogleContents(messages: ReadonlyArray<AgentStreamRequest["messages"][number]>): unknown[] {
  const contents: unknown[] = [];
  let responses: unknown[] = [];
  const flushResponses = (): void => {
    if (responses.length === 0) return;
    contents.push({ role: "user", parts: responses });
    responses = [];
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      responses.push({
        functionResponse: {
          ...(typeof message.toolCallId === "string" && message.toolCallId.length > 0 ? { id: message.toolCallId } : {}),
          name: message.toolName ?? "",
          response: googleResponseValue(message.content),
        },
      });
      continue;
    }
    flushResponses();
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const parts: unknown[] = [];
      if (typeof message.content === "string" && message.content.length > 0) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments) as unknown;
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            ...(typeof call.id === "string" && call.id.length > 0 ? { id: call.id } : {}),
            name: call.name,
            args,
          },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : message.role,
      parts: [{ text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }],
    });
  }
  flushResponses();
  return contents;
}

interface AnthropicEvent {
  readonly type?: string;
  readonly index?: number;
  readonly message?: { readonly id?: string; readonly usage?: unknown };
  readonly usage?: unknown;
  readonly error?: { readonly type?: string };
  readonly content_block?: { readonly type?: string; readonly id?: string; readonly name?: string };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string;
  };
}

async function* parseAnthropicSse(body: ReadableStream<Uint8Array>, startedAt: number): AsyncIterableIterator<AgentStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId: string | undefined;
  let usage: unknown;
  let stopReason = "stop";
  let completed = false;
  const blocks = new Map<number, { id?: string; name: string; json: string }>();

  try {
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
          if (event.type === "message_start") {
            if (typeof event.message?.id === "string") responseId = event.message.id;
            if (event.message?.usage !== undefined) usage = event.message.usage;
          } else if (event.type === "message_delta") {
            if (event.usage !== undefined) usage = { ...(typeof usage === "object" && usage !== null ? usage : {}), ...event.usage };
            if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
          } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            blocks.set(event.index ?? blocks.size, { id: event.content_block.id, name: event.content_block.name ?? "", json: "" });
          } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") yield delta.text;
            else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning", text: delta.thinking };
            else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const block = blocks.get(event.index ?? 0);
              if (block !== undefined) block.json += delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            const block = blocks.get(event.index ?? 0);
            if (block !== undefined && block.name.length > 0) {
              yield { type: "tool_call", id: block.id, name: block.name, arguments: block.json };
              blocks.delete(event.index ?? 0);
            }
          } else if (event.type === "error") {
            yield errorChunk({ code: event.error?.type ?? "unknown", message: `ANTHROPIC_ERROR ${event.error?.type ?? "unknown"}`, provider: "anthropic", responseId });
            return;
          } else if (event.type === "message_stop") {
            completed = true;
            yield doneChunk(stopReason === "max_tokens" ? "length" : stopReason === "end_turn" || stopReason === "stop_sequence" ? "stop" : "error", { usage, responseId, startedAt });
            return;
          }
        }
      }
    }
    yield completed
      ? doneChunk(stopReason === "max_tokens" ? "length" : "stop", { usage, responseId, startedAt })
      : incompleteStreamChunk("anthropic", { responseId, startedAt });
  } finally {
    reader.releaseLock();
  }
}

interface GoogleEvent {
  readonly responseId?: string;
  readonly usageMetadata?: unknown;
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        readonly thought?: boolean;
        readonly functionCall?: { readonly name?: string; readonly args?: unknown };
      }[];
    };
  }[];
}

async function* parseGoogleSse(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
): AsyncIterableIterator<AgentStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId: string | undefined;
  let usage: unknown;
  let finishReason: string | undefined;
  let callSeq = 0;
  try {
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
          responseId = event.responseId ?? responseId;
          usage = event.usageMetadata ?? usage;
          for (const candidate of event.candidates ?? []) {
            finishReason = candidate.finishReason ?? finishReason;
            for (const part of candidate.content?.parts ?? []) {
              if (typeof part.text === "string" && part.text.length > 0) {
                yield part.thought === true ? { type: "reasoning", text: part.text } : part.text;
              }
              if (part.functionCall !== undefined && typeof part.functionCall.name === "string") {
                // Gemini 的 functionCall 不保证携带 id；按流内序号生成稳定 id 供 functionResponse 关联。
                callSeq += 1;
                yield {
                  type: "tool_call",
                  id: `google-call-${callSeq}`,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                };
              }
            }
          }
        }
      }
    }
    if (finishReason === undefined) {
      yield incompleteStreamChunk("google", { responseId, startedAt });
    } else {
      const stopReason = finishReason === "MAX_TOKENS"
        ? "length"
        : finishReason === "STOP"
          ? "stop"
          : "error";
      yield doneChunk(stopReason, { usage, responseId, startedAt });
    }
  } finally {
    reader.releaseLock();
  }
}

export function createProviderStreamFn(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch
): AgentStreamFn {
  const info = PROVIDERS.find((entry) => entry.id === config.provider) as ProviderInfo | undefined;
  if (info === undefined) {
    throw new Error(`UNKNOWN_PROVIDER: ${config.provider}（可用：${PROVIDERS.map((p) => p.id).join(", ")}）`);
  }
  // 只在所选 provider 的模型集合内解析别名，避免把别的 provider 的模型名发给当前端点。
  const registry = createModelRegistry(MODELS.filter((entry) => entry.provider === config.provider));
  const model = registry.resolve(config.model);
  if (model === undefined) throw new Error(`UNKNOWN_MODEL: ${config.model}`);
  const baseUrl = resolveBaseUrl(info, config.baseUrl);
  const modelName = model.name;

  // 边界优先级：credentialBroker > vault 对 > env / 显式 key。provider 侧永远只看到占位符 token。
  const vault = config.credentialVault;
  const broker = config.secretBroker;
  const unified = config.credentialBoundary;
  let apiKey: string;
  let boundaryFetch: typeof fetch = fetchImpl;
  if (unified !== undefined) {
    apiKey = unified.handle.token;
    boundaryFetch = withCredentialFetch(unified.broker, unified.handle, fetchImpl);
  } else if (vault !== undefined && broker !== undefined) {
    const parsedBase = new URL(baseUrl);
    const placeholder = vault.issue({
      name: `provider:${config.provider}:${modelName}`,
      binding: {
        scheme: parsedBase.protocol.replace(/:$/, ""),
        host: parsedBase.host,
        ...(parsedBase.pathname.replace(/\/+$/, "") !== ""
          ? { path: parsedBase.pathname.replace(/\/+$/, "") }
          : {}),
        methods: ["POST"],
      },
    });
    // provider 拿到的只是占位符 token；明文 key 不进入 config、请求 URL/header 构造对象或日志。
    apiKey = placeholder.token;
    boundaryFetch = withCredentialBoundary(vault, placeholder, broker, fetchImpl);
  } else {
    apiKey = resolveApiKey(config.provider, config.apiKey);
  }

  let stream: AgentStreamFn;
  if (info.api === "openai-responses") {
    // OpenAI Responses API：/responses + instructions/input。
    stream = createOpenAiResponsesStreamFn({ baseUrl, apiKey, model: modelName }, boundaryFetch);
  } else if (info.api !== "anthropic-messages" && info.api !== "google-generate") {
    // openai-chat 与 bedrock-invoke 均通过 OpenAI 兼容 SSE 网关对接。
    stream = createOpenAiStreamFn({ baseUrl, apiKey, model: modelName }, boundaryFetch);
  } else {
    stream = async function* (request: AgentStreamRequest) {
      let url: string;
      let init: RequestInit;
      let parse: (body: ReadableStream<Uint8Array>, startedAt: number) => AsyncIterableIterator<AgentStreamChunk>;

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
          contents: toGoogleContents(request.messages),
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

    const startedAt = Date.now();
    const response = await boundaryFetch(url, {
      ...init,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      yield errorChunk(httpError(config.provider, response));
      return;
    }
    if (response.body === null) {
      yield errorChunk({ code: "invalid_response", message: `${config.provider.toUpperCase()}_NO_BODY`, provider: config.provider });
      return;
    }
    yield* parse(response.body, startedAt);
    };
  }
  return config.retry === undefined || config.retry === false
    ? stream
    : withProviderRetry(stream, config.retry);
}
