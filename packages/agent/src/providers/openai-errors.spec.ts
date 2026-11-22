import { describe, expect, test } from "bun:test";
import { createOpenAiResponsesStreamFn } from "./openai-responses";

function sse(frames: readonly string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }), { status: 200 });
}

/** CR-28：上游错误原文不得进入会话可见文本。 */
describe("T-27 错误原文降级", () => {
  test("流内 error 事件的 message 不进入抛出的 Error 文本", async () => {
    const fake = (async () => sse([
      'data: {"type":"error","code":"rate_limit","message":"SECRET_UPSTREAM_DETAIL user=data"}\n\n',
    ])) as unknown as typeof fetch;
    let message = "";
    try {
      await Array.fromAsync(createOpenAiResponsesStreamFn(
        { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" }, fake,
      )({ messages: [] }));
    } catch (e) { message = (e as Error).message; }
    expect(message).toContain("OPENAI_RESPONSES_ERROR");
    expect(message).not.toContain("SECRET_UPSTREAM_DETAIL");
  });

  test("response.failed 的错误 message 不进入会话", async () => {
    const fake = (async () => sse([
      'data: {"type":"response.failed","response":{"error":{"code":"server","message":"LEAKED_INTERNAL_TRACE"}}}\n\n',
    ])) as unknown as typeof fetch;
    let message = "";
    try {
      await Array.fromAsync(createOpenAiResponsesStreamFn(
        { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" }, fake,
      )({ messages: [] }));
    } catch (e) { message = (e as Error).message; }
    expect(message).toContain("OPENAI_RESPONSES_FAILED");
    expect(message).not.toContain("LEAKED_INTERNAL_TRACE");
  });
});
