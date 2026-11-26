import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamRequest } from "../facade";
import { createProviderStreamFn } from "./dispatch";
import { withProviderRetry } from "./retry";

function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function collect(iterable: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  return await Array.fromAsync(iterable);
}

function provider(config: Parameters<typeof createProviderStreamFn>[0], frames: readonly string[]): AgentStreamFnForTest {
  const host = new URL(config.baseUrl ?? "https://eof.test/v1").hostname;
  const gated = {
    ...config,
    egress: { allow: [{ host, port: 443 }] },
  };
  return async (request) => collect(createProviderStreamFn(gated, (async () => sse(frames)) as unknown as typeof fetch)(request));
}

type AgentStreamFnForTest = (request: AgentStreamRequest) => Promise<AgentStreamChunk[]>;

const request: AgentStreamRequest = { messages: [{ role: "user", content: "hi" }] };

describe("T-09 provider EOF 终态", () => {
  test("OpenAI 流缺少 [DONE]/finish_reason 时归一化为 incomplete_stream/no_completion", async () => {
    const chunks = await provider(
      { provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://eof.test/v1" },
      ['data: {"id":"r1","choices":[{"delta":{"content":"partial"}}]}\n\n'],
    )(request);
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      error: { code: "incomplete_stream", message: "no_completion", provider: "openai", responseId: "r1" },
    });
  });

  test("Anthropic 流缺少 message_stop 时不伪装 stop", async () => {
    const chunks = await provider(
      { provider: "anthropic", model: "sonnet", apiKey: "k", baseUrl: "https://eof.test/v1" },
      ['data: {"type":"message_start","message":{"id":"msg-1"}}\n\n', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'],
    )(request);
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      error: { code: "incomplete_stream", message: "no_completion", provider: "anthropic" },
    });
  });

  test("Google 流缺少 finishReason 时不伪装 stop", async () => {
    const chunks = await provider(
      { provider: "google", model: "flash", apiKey: "k", baseUrl: "https://eof.test/v1beta" },
      ['data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}],"responseId":"g1"}\n\n'],
    )(request);
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      error: { code: "incomplete_stream", message: "no_completion", provider: "google", responseId: "g1" },
    });
  });

  test("Responses 流无 completed 时统一为 incomplete_stream/no_completion", async () => {
    const chunks = await provider(
      { provider: "openai-responses", model: "responses", apiKey: "k", baseUrl: "https://eof.test/v1" },
      ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n'],
    )(request);
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      error: { code: "incomplete_stream", message: "no_completion", provider: "openai-responses" },
    });
  });

  test("retry 包装的流 EOF 无 terminal 也不返回 stop", async () => {
    const chunks = await collect(withProviderRetry(async function* () {
      yield "partial";
    }, { maxRetries: 0 })(request));
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      error: { code: "incomplete_stream", message: "no_completion" },
    });
  });
});

describe("T-09 Google function-calling 多轮", () => {
  test("稳定调用 id 与并行 functionResponse 不串不丢", async () => {
    let captured: RequestInit | undefined;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return sse([
        'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"functionCall":{"name":"read","args":{"p":"a"}}},{"functionCall":{"name":"write","args":{"p":"b"}}}]}}],"responseId":"g2"}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const multiTurn: AgentStreamRequest = {
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "google-call-1", name: "read", arguments: '{"p":"a"}' },
            { id: "google-call-2", name: "write", arguments: '{"p":"b"}' },
          ],
        },
        { role: "toolResult", content: "A", toolCallId: "google-call-1", toolName: "read" },
        { role: "toolResult", content: "B", toolCallId: "google-call-2", toolName: "write" },
      ],
    };
    const chunks = await collect(createProviderStreamFn(
      { provider: "google", model: "flash", apiKey: "k", baseUrl: "https://google.test/v1beta", egress: { allow: [{ host: "google.test", port: 443 }] } },
      fakeFetch,
    )(multiTurn));

    expect(chunks.filter((chunk) => typeof chunk === "object" && chunk.type === "tool_call")).toEqual([
      { type: "tool_call", id: "google-call-1", name: "read", arguments: '{"p":"a"}' },
      { type: "tool_call", id: "google-call-2", name: "write", arguments: '{"p":"b"}' },
    ]);
    const body = JSON.parse(String(captured?.body)) as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.contents[1]?.role).toBe("model");
    expect(body.contents[1]?.parts).toEqual([
      { functionCall: { id: "google-call-1", name: "read", args: { p: "a" } } },
      { functionCall: { id: "google-call-2", name: "write", args: { p: "b" } } },
    ]);
    expect(body.contents[2]?.role).toBe("user");
    expect(body.contents[2]?.parts).toEqual([
      { functionResponse: { id: "google-call-1", name: "read", response: { output: "A" } } },
      { functionResponse: { id: "google-call-2", name: "write", response: { output: "B" } } },
    ]);
  });
});
