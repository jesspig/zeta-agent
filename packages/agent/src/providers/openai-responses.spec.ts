import { describe, expect, test } from "bun:test";
import type { AgentStreamRequest, AgentStreamChunk } from "../facade";
import { createOpenAiResponsesStreamFn } from "./openai-responses";

function sse(frames: readonly string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

const request: AgentStreamRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
  tools: [{ name: "read", description: "read file", parameters: [{ name: "path", type: "string", description: "path", required: true }] }],
};

async function collect(iterable: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  const out: AgentStreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function lastErrorMessage(chunks: readonly AgentStreamChunk[]): string {
  const last = chunks.at(-1);
  return typeof last === "object" && last.type === "error" ? last.error.message : "";
}

describe("OpenAI Responses 适配器", () => {
  test("POST /responses，instructions 与 input 分离，工具 schema 为 function 形态", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return sse([
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const out = await collect(
      createOpenAiResponsesStreamFn({ baseUrl: "https://api.openai.com/v1/", apiKey: "dummy", model: "gpt-4o" }, fakeFetch)(request)
    );
    expect(out.slice(0, -1)).toEqual(["ok"]);
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(captured.url).toBe("https://api.openai.com/v1/responses");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer dummy");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("sys");
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].name).toBe("read");
    expect(body.tools[0].parameters.required).toEqual(["path"]);
  });

  test("解析 reasoning 与 output_text 增量", async () => {
    const fakeFetch = (async () =>
      sse([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hel"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ])) as unknown as typeof fetch;
    const out = await collect(
      createOpenAiResponsesStreamFn({ baseUrl: "https://api.openai.com/v1", apiKey: "dummy", model: "gpt-4o" }, fakeFetch)(request)
    );
    expect(out.slice(0, -1)).toEqual([{ type: "reasoning", text: "think" }, "hel", "lo"]);
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("解析 function_call：增量参数在 output_item.done 汇成 tool_call", async () => {
    const req: AgentStreamRequest = {
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "fc_1", name: "read", arguments: '{"path":"/a"}' }],
        },
        { role: "toolResult", content: "content", toolCallId: "fc_1" },
      ],
    };
    let captured: { init?: RequestInit } = {};
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = { init };
      return sse([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_x","call_id":"fc_x","name":"write"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"a\\""}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta\\":1}"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"fc_x","name":"write","arguments":"{\\"a\\":1}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const out = await collect(
      createOpenAiResponsesStreamFn({ baseUrl: "https://api.openai.com/v1", apiKey: "dummy", model: "gpt-4o" }, fakeFetch)(req)
    );
    expect(out.slice(0, -1)).toEqual([{ type: "tool_call", id: "fc_x", name: "write", arguments: '{"a":1}' }]);
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    const body = JSON.parse(String(captured.init?.body));
    expect(body.input).toContainEqual({ type: "function_call", call_id: "fc_1", name: "read", arguments: '{"path":"/a"}' });
    expect(body.input).toContainEqual({ type: "function_call_output", call_id: "fc_1", output: "content" });
  });

  test("error 事件与非 2xx 响应产出 sanitized error chunk 且不泄露凭据", async () => {
    const errFetch = (async () =>
      sse(['data: {"type":"error","code":"rate_limit","message":"slow down"}\n\n'])) as unknown as typeof fetch;
    const errChunks = await collect(
      createOpenAiResponsesStreamFn({ baseUrl: "https://api.openai.com/v1", apiKey: "secret", model: "gpt-4o" }, errFetch)(request)
    );
    expect(lastErrorMessage(errChunks)).toContain("OPENAI_RESPONSES_ERROR");
    expect(lastErrorMessage(errChunks)).toContain("rate_limit");
    expect(JSON.stringify(errChunks)).not.toContain("secret");

    const httpFetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const httpChunks = await collect(
      createOpenAiResponsesStreamFn({ baseUrl: "https://api.openai.com/v1", apiKey: "secret", model: "gpt-4o" }, httpFetch)(request)
    );
    expect(lastErrorMessage(httpChunks)).toContain("OPENAI_RESPONSES_HTTP_401");
    expect(JSON.stringify(httpChunks)).not.toContain("secret");
  });
});
