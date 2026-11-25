import type { AgentStopReason, AgentStreamChunk, AgentStreamError, AgentUsage } from "../facade";
import { parseRetryAfter } from "./retry";

function numeric(record: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function normalizeUsage(value: unknown): AgentUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = numeric(record, "input_tokens", "inputTokens", "prompt_tokens", "promptTokenCount");
  const outputTokens = numeric(record, "output_tokens", "outputTokens", "completion_tokens", "candidatesTokenCount");
  const totalTokens = numeric(record, "total_tokens", "totalTokens", "totalTokenCount")
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function doneChunk(
  stopReason: AgentStopReason,
  metadata: { usage?: unknown; responseId?: string; startedAt: number } = { startedAt: 0 },
): Extract<AgentStreamChunk, { type: "done" }> {
  const usage = normalizeUsage(metadata.usage);
  return {
    type: "done",
    stopReason,
    ...(usage !== undefined ? { usage } : {}),
    durationMs: Math.max(0, Date.now() - metadata.startedAt),
    ...(metadata.responseId !== undefined ? { responseId: metadata.responseId } : {}),
  };
}

export function errorChunk(error: AgentStreamError): Extract<AgentStreamChunk, { type: "error" }> {
  return { type: "error", error };
}

/** 流提前结束且没有 provider 终态时的统一归一化；绝不伪装成 stop。 */
export function incompleteStreamChunk(
  provider: string,
  metadata: { responseId?: string; startedAt?: number } = {}
): Extract<AgentStreamChunk, { type: "error" }> {
  return errorChunk({
    code: "incomplete_stream",
    message: "no_completion",
    provider,
    ...(metadata.responseId !== undefined ? { responseId: metadata.responseId } : {}),
    ...(metadata.startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - metadata.startedAt) } : {}),
  });
}

export function httpError(provider: string, response: Response): AgentStreamError {
  const status = response.status;
  const code = status === 429 ? "rate_limit" : status >= 500 ? "server" : status === 401 || status === 403 ? "auth" : status >= 400 && status < 500 ? "invalid_request" : "http_error";
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return {
    code,
    message: `${provider.toUpperCase()}_HTTP_${status}`,
    status,
    provider,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
