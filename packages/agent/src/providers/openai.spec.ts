import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamRequest } from "../facade";
import { createOpenAiStreamFn, toOpenAiMessages, type OpenAiConfig } from "./openai";

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const config: OpenAiConfig = { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "m1" };

describe("OpenAI 兼容 provider", () => {
  test("按 SSE delta 产出内容片段", async () => {
    const request: AgentStreamRequest = { messages: [{ role: "user", content: "hi" }] };
    const fakeFetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;
    const streamFn = createOpenAiStreamFn(config, fakeFetch);
    const out: string[] = [];
    for await (const chunk of streamFn(request)) {
      if (typeof chunk === "string") out.push(chunk);
    }
    expect(out).toEqual(["hel", "lo"]);
  });

  test("请求体含 model/messages/stream 且带 Bearer 头", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return sseResponse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const request: AgentStreamRequest = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    };
    const out: string[] = [];
    for await (const chunk of createOpenAiStreamFn(config, fakeFetch)(request)) {
      if (typeof chunk === "string") out.push(chunk);
    }

    expect(captured.url).toBe("https://example.test/v1/chat/completions");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("m1");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  test("解析 reasoning 与 tool_calls，并在请求体发送 tools", async () => {
    let captured: RequestInit | undefined;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;
    const request: AgentStreamRequest = {
      messages: [{ role: "user", content: "read" }],
      tools: [{ name: "read", description: "read file", parameters: [{ name: "path", type: "string", description: "p", required: true }] }],
    };
    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of createOpenAiStreamFn(config, fakeFetch)(request)) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: "reasoning", text: "想一想" });
    expect(chunks).toContainEqual({
      type: "tool_call",
      id: "c1",
      name: "read",
      arguments: '{"path":"a.ts"}',
    });
    const body = JSON.parse(String(captured?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("read");
    expect(body.tool_choice).toBe("auto");
  });

  test("工具结果以 role=tool + tool_call_id 回传", async () => {
    const messages = toOpenAiMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { role: "toolResult", content: "out", toolCallId: "c1", toolName: "read" },
    ]);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "out" });
  });

  test("非 2xx 响应抛错且不泄露 key", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const request: AgentStreamRequest = { messages: [{ role: "user", content: "hi" }] };
    let message = "";
    try {
      for await (const _ of createOpenAiStreamFn(config, fakeFetch)(request)) void _;
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("OPENAI_HTTP_401");
    expect(message).not.toContain("test-key");
  });
});
