import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk } from "../facade";
import { createOpenAiResponsesStreamFn } from "./openai-responses";

function sse(frames: readonly string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }), { status: 200 });
}

function lastErrorMessage(chunks: readonly AgentStreamChunk[]): string {
  const last = chunks.at(-1);
  return typeof last === "object" && last.type === "error" ? last.error.message : "";
}

/** CR-28：上游错误原文不得进入会话可见文本。 */
describe("T-27 错误原文降级", () => {
  test("流内 error 事件的 message 不进入会话终态", async () => {
    const fake = (async () => sse([
      'data: {"type":"error","code":"rate_limit","message":"SECRET_UPSTREAM_DETAIL user=data"}\n\n',
    ])) as unknown as typeof fetch;
    const chunks = await Array.fromAsync(createOpenAiResponsesStreamFn(
      { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" }, fake,
    )({ messages: [] }));
    expect(lastErrorMessage(chunks)).toContain("OPENAI_RESPONSES_ERROR");
    expect(JSON.stringify(chunks)).not.toContain("SECRET_UPSTREAM_DETAIL");
  });

  test("response.failed 的错误 message 不进入会话", async () => {
    const fake = (async () => sse([
      'data: {"type":"response.failed","response":{"error":{"code":"server","message":"LEAKED_INTERNAL_TRACE"}}}\n\n',
    ])) as unknown as typeof fetch;
    const chunks = await Array.fromAsync(createOpenAiResponsesStreamFn(
      { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" }, fake,
    )({ messages: [] }));
    expect(lastErrorMessage(chunks)).toContain("OPENAI_RESPONSES_FAILED");
    expect(JSON.stringify(chunks)).not.toContain("LEAKED_INTERNAL_TRACE");
  });
});
