import type { AgentStreamChunk, AgentStreamError, AgentStreamFn } from "../facade";

export type ProviderErrorKind = "rate_limit" | "server" | "timeout" | "network" | "auth" | "invalid_request" | "aborted" | "unknown";

export interface ClassifiedProviderError {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly error: AgentStreamError;
}

export interface ProviderRetryOptions {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function classifyProviderError(value: unknown): ClassifiedProviderError {
  const record = recordOf(value);
  const nested = recordOf(record.error);
  const status = typeof record.status === "number" ? record.status : typeof nested.status === "number" ? nested.status : undefined;
  const rawCode = typeof record.code === "string" ? record.code : typeof nested.code === "string" ? nested.code : "unknown";
  const code = rawCode.toLowerCase();
  let kind: ProviderErrorKind = "unknown";
  if (code.includes("abort")) kind = "aborted";
  else if (status === 401 || status === 403 || code.includes("auth")) kind = "auth";
  else if (status === 429 || code.includes("rate_limit") || code.includes("quota")) kind = "rate_limit";
  else if (status !== undefined && status >= 500 || code.includes("server") || code.includes("internal")) kind = "server";
  else if (status === 408 || code.includes("timeout") || code.includes("timed_out")) kind = "timeout";
  else if (code.includes("network") || code.includes("fetch") || code.includes("connection")) kind = "network";
  else if (status !== undefined && status >= 400 && status < 500 || code.includes("invalid")) kind = "invalid_request";
  const retryable = kind === "rate_limit" || kind === "server" || kind === "timeout" || kind === "network"
    || (status !== undefined && RETRYABLE_STATUSES.has(status));
  const message = typeof record.message === "string" ? record.message : typeof nested.message === "string" ? nested.message : value instanceof Error ? value.message : String(value);
  return {
    kind,
    retryable: kind !== "aborted" && retryable,
    error: {
      code: kind === "unknown" ? rawCode : kind,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(typeof record.retryAfterMs === "number" ? { retryAfterMs: record.retryAfterMs } : {}),
      ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
      ...(typeof record.responseId === "string" ? { responseId: record.responseId } : {}),
    },
  };
}

export function parseRetryAfter(value: string | number | null | undefined, now = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function retryDelayMs(
  attempt: number,
  error: AgentStreamError,
  options: ProviderRetryOptions = {},
): number {
  const initial = options.initialDelayMs ?? 250;
  const maximum = options.maxBackoffMs ?? 30_000;
  const exponential = Math.min(maximum, initial * 2 ** Math.max(0, attempt));
  const jitter = (options.random?.() ?? 0.5) * Math.min(100, exponential);
  return Math.min(maximum, Math.max(0, error.retryAfterMs ?? exponential + jitter));
}

export async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new DOMException("ABORTED", "AbortError");
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("ABORTED", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorChunk(error: AgentStreamError): AgentStreamChunk {
  return { type: "error", error };
}

/** 只在尚未对外产出内容/工具调用时重试，避免重复文本与副作用。 */
export function withProviderRetry(streamFn: AgentStreamFn, options: ProviderRetryOptions = {}): AgentStreamFn {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const sleep = options.sleep ?? sleepWithAbort;
  return async function* (request) {
    const isAborted = (): boolean => request.signal?.aborted === true;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let emitted = false;
      try {
        if (isAborted()) throw new DOMException("ABORTED", "AbortError");
        let terminal: boolean = false;
        for await (const chunk of streamFn(request)) {
          if (isAborted()) throw new DOMException("ABORTED", "AbortError");
          if (typeof chunk === "object" && chunk.type === "error") throw chunk.error;
          if (typeof chunk === "object" && chunk.type === "done") {
            terminal = true;
            yield chunk;
            return;
          }
          if (typeof chunk !== "string" || chunk.length > 0) emitted = true;
          yield chunk;
        }
        if (!terminal) {
          yield { type: "done", stopReason: isAborted() ? "aborted" : "stop" };
          return;
        }
      } catch (value) {
        const classified = classifyProviderError(value);
        const error = isAborted()
          ? { code: "aborted", message: "ABORTED" }
          : classified.error;
        if (isAborted() || error.code === "aborted" || emitted || !classified.retryable || attempt >= maxRetries) {
          yield errorChunk(error);
          return;
        }
        try {
          await sleep(retryDelayMs(attempt, error, options), request.signal);
        } catch {
          yield errorChunk({ code: "aborted", message: "ABORTED" });
          return;
        }
      }
    }
  };
}
