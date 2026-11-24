import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamFn, AgentStreamRequest } from "../facade";
import { classifyProviderError, parseRetryAfter, sleepWithAbort, withProviderRetry } from "./retry";

const request: AgentStreamRequest = { messages: [] };

async function collect(iterable: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  return await Array.fromAsync(iterable);
}

describe("T-07 中央 retry 与取消", () => {
  test("分类 429/5xx 为可重试，4xx 与 abort 不重试", () => {
    expect(classifyProviderError({ status: 429 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 503 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 401 }).retryable).toBe(false);
    expect(classifyProviderError({ status: 400 }).retryable).toBe(false);
    expect(classifyProviderError({ code: "aborted" }).kind).toBe("aborted");
  });

  test("Retry-After 支持秒数与 HTTP 日期", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  test("输出前 429 可重试，Retry-After 受最大退避限制", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const stream: AgentStreamFn = async function* () {
      attempts += 1;
      if (attempts === 1) yield { type: "error", error: { code: "rate_limit", message: "limited", status: 429, retryAfterMs: 60_000 } };
      else yield { type: "done", stopReason: "stop" };
    };
    const chunks = await collect(withProviderRetry(stream, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxBackoffMs: 10,
      sleep: async (ms) => { delays.push(ms); },
    })(request));
    expect(attempts).toBe(2);
    expect(delays).toEqual([10]);
    expect(chunks.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("已有文本/工具输出后不盲重试", async () => {
    let attempts = 0;
    const stream: AgentStreamFn = async function* () {
      attempts += 1;
      yield "partial";
      yield { type: "error", error: { code: "server", message: "failed", status: 503 } };
    };
    const chunks = await collect(withProviderRetry(stream, { maxRetries: 3, sleep: async () => {} })(request));
    expect(attempts).toBe(1);
    expect(chunks[0]).toBe("partial");
    const last = chunks.at(-1);
    expect(typeof last === "object" ? last.type : undefined).toBe("error");
  });

  test("abortable sleep 立即响应取消", async () => {
    const controller = new AbortController();
    const sleeping = sleepWithAbort(10_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toThrow();
  });

  test("重试等待中 abort 产出 aborted error 且不再请求", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let releaseSleep!: () => void;
    const stream: AgentStreamFn = async function* () {
      attempts += 1;
      yield { type: "error", error: { code: "rate_limit", message: "limited", status: 429 } };
    };
    const running = collect(withProviderRetry(stream, {
      maxRetries: 3,
      sleep: async () => await new Promise<void>((resolve) => {
        releaseSleep = resolve;
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    })({ ...request, signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    releaseSleep?.();
    const chunks = await running;
    expect(attempts).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
  });
});
