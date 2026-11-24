import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamRequest } from "../facade";
import { createProviderStreamFn } from "./dispatch";

function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  return await Array.fromAsync(iterable);
}

const request: AgentStreamRequest = { messages: [{ role: "user", content: "hi" }] };

describe("T-07 provider conformance 终态矩阵", () => {
  test("OpenAI chat 映射 finish_reason、usage、responseId 并释放 reader", async () => {
    const response = sse([
      'data: {"id":"chat-1","choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}\n\n',
      'data: {"id":"chat-1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(createProviderStreamFn(
      { provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://openai.test/v1" },
      (async () => response) as unknown as typeof fetch,
    )(request));
    expect(chunks.at(-1)).toEqual({
      type: "done",
      stopReason: "length",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      responseId: "chat-1",
      durationMs: expect.any(Number),
    });
    expect(response.body?.locked).toBe(false);
  });

  test("Responses completed/incomplete 使用统一 done 且不交付截断工具", async () => {
    for (const [event, stopReason] of [
      ['{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":4,"output_tokens":6}}}', "stop"],
      ['{"type":"response.incomplete","response":{"id":"r2","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":6}}}', "length"],
    ] as const) {
      const chunks = await collect(createProviderStreamFn(
        { provider: "openai-responses", model: "responses", apiKey: "k", baseUrl: "https://responses.test/v1" },
        (async () => sse([`data: ${event}\n\n`])) as unknown as typeof fetch,
      )(request));
      expect(chunks.at(-1)).toMatchObject({ type: "done", stopReason, responseId: event.includes("r1") ? "r1" : "r2" });
      expect(chunks.some((chunk) => typeof chunk === "object" && chunk.type === "tool_call")).toBe(false);
    }
  });

  test("Anthropic 映射 message_delta stop_reason 与 usage", async () => {
    const chunks = await collect(createProviderStreamFn(
      { provider: "anthropic", model: "sonnet", apiKey: "k", baseUrl: "https://anthropic.test/v1" },
      (async () => sse([
        'data: {"type":"message_start","message":{"id":"msg-1","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ])) as unknown as typeof fetch,
    )(request));
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      stopReason: "length",
      responseId: "msg-1",
      usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 },
    });
  });

  test("Google 映射 finishReason 与 usageMetadata", async () => {
    const chunks = await collect(createProviderStreamFn(
      { provider: "google", model: "flash", apiKey: "k", baseUrl: "https://google.test/v1beta" },
      (async () => sse([
        'data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"ok"}]}}],"responseId":"g1","usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":9,"totalTokenCount":12}}\n\n',
      ])) as unknown as typeof fetch,
    )(request));
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      stopReason: "length",
      responseId: "g1",
      usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
    });
  });

  test("HTTP 429 映射可分类 error chunk 与 Retry-After", async () => {
    const chunks = await collect(createProviderStreamFn(
      { provider: "openai", model: "gpt-4o", apiKey: "secret", baseUrl: "https://openai.test/v1" },
      (async () => new Response("limited", { status: 429, headers: { "retry-after": "2" } })) as unknown as typeof fetch,
    )(request));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "error",
      error: { status: 429, retryAfterMs: 2000, provider: "openai", code: "rate_limit" },
    });
    expect(JSON.stringify(chunks)).not.toContain("secret");
  });
});
