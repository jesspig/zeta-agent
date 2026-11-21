import type { AgentStreamFn, AgentStreamRequest } from "../facade";
import { PROVIDERS } from "./catalog.generated";
import { createModelRegistry } from "./registry";

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

function toChatMessage(message: AgentStreamRequest["messages"][number]): { role: string; content: string } {
  const role = message.role === "toolResult" ? "user" : message.role;
  return { role, content: String(message.content) };
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  extract: (parsed: unknown) => string[]
): AsyncIterableIterator<string> {
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          continue;
        }
        for (const chunk of extract(parsed)) {
          if (chunk.length > 0) yield chunk;
        }
      }
    }
  }
}

function extractOpenAi(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  const first = choices[0];
  if (typeof first !== "object" || first === null) return [];
  const delta = (first as { delta?: { content?: unknown } }).delta;
  if (typeof delta?.content === "string") return [delta.content];
  return [];
}

function extractAnthropic(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const type = (parsed as { type?: unknown }).type;
  if (type !== "content_block_delta") return [];
  const delta = (parsed as { delta?: { type?: unknown; text?: unknown } }).delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string") return [delta.text];
  return [];
}

function extractGoogle(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
        out.push((part as { text: string }).text);
      }
    }
  }
  return out;
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

  return async function* (request: AgentStreamRequest) {
    let url: string;
    let init: RequestInit;
    let extract: (parsed: unknown) => string[];

    if (info.api === "anthropic-messages") {
      url = `${baseUrl}/messages`;
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
            .map((m) => ({ role: m.role === "toolResult" ? "user" : m.role, content: String(m.content) })),
        }),
      };
      extract = extractAnthropic;
    } else if (info.api === "google-generate") {
      url = `${baseUrl}/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: request.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : m.role === "toolResult" ? "user" : m.role,
            parts: [{ text: String(m.content) }],
          })),
        }),
      };
      extract = extractGoogle;
    } else {
      // openai-chat 与 bedrock-invoke 均通过 OpenAI 兼容 SSE 网关对接，
      // 避免引入各家 SDK 大依赖（见实现报告"偏离项"）。
      url = `${baseUrl}/chat/completions`;
      init = {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, messages: request.messages.map(toChatMessage), stream: true }),
      };
      extract = extractOpenAi;
    }

    const response = await fetchImpl(url, init);
    if (!response.ok) throw httpError(response.status, config.provider);
    if (response.body === null) throw new Error(`${config.provider.toUpperCase()}_NO_BODY`);
    yield* parseSse(response.body, extract);
  };
}
