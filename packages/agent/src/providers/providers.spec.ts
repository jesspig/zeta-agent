import { describe, expect, test } from "bun:test";
import type { AgentStreamRequest } from "../facade";
import { createProviderStreamFn } from "./dispatch";

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
};

async function collect(iterable: AsyncIterable<string | { readonly type: string; readonly text?: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    if (typeof chunk === "string") out.push(chunk);
    else if (typeof chunk.text === "string") out.push(chunk.text);
  }
  return out;
}

describe("多 provider 流式接口（T-12）", () => {
  test("openai-chat 家族：groq/deepseek/openrouter 走 OpenAI 兼容 /chat/completions", async () => {
    for (const provider of ["groq", "deepseek", "openrouter"]) {
      let captured: { url?: string; init?: RequestInit } = {};
      const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return sse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      }) as unknown as typeof fetch;
      const out = await collect(
        createProviderStreamFn(
          { provider, model: "llama", apiKey: "dummy", baseUrl: `https://${provider}.test/v1` },
          fakeFetch
        )(request)
      );
      expect(out).toEqual(["ok"]);
      expect(captured.url).toBe(`https://${provider}.test/v1/chat/completions`);
      expect(new Headers(captured.init?.headers).get("Authorization")).toBe("Bearer dummy");
    }
  });

  test("anthropic：/messages + x-api-key + anthropic-version，解析 content_block_delta", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return sse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const out = await collect(
      createProviderStreamFn(
        { provider: "anthropic", model: "sonnet", apiKey: "dummy", baseUrl: "https://anthropic.test/v1" },
        fakeFetch
      )(request)
    );
    expect(out).toEqual(["hel", "lo"]);
    expect(captured.url).toBe("https://anthropic.test/v1/messages");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("x-api-key")).toBe("dummy");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("google：:streamGenerateContent?alt=sse&key，解析 candidates text", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return sse([
        'data: {"candidates":[{"content":{"parts":[{"text":"gem"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"ini"}]}}]}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const out = await collect(
      createProviderStreamFn(
        { provider: "google", model: "flash", apiKey: "dummy", baseUrl: "https://google.test/v1beta" },
        fakeFetch
      )(request)
    );
    expect(out).toEqual(["gem", "ini"]);
    expect(captured.url).toContain("/models/gemini-2.5-flash:streamGenerateContent");
    expect(captured.url).toContain("alt=sse");
    expect(captured.url).toContain("key=dummy");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(body.system_instruction).toEqual({ parts: [{ text: "sys" }] });
  });

  test("bedrock：走 OpenAI 兼容网关（bedrock-invoke 等价适配器）", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return sse(['data: {"choices":[{"delta":{"content":"bed"}}]}\n\n', "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const out = await collect(
      createProviderStreamFn(
        { provider: "bedrock", model: "nova", apiKey: "dummy", baseUrl: "https://bedrock-gw.test/v1" },
        fakeFetch
      )(request)
    );
    expect(out).toEqual(["bed"]);
    expect(captured.url).toBe("https://bedrock-gw.test/v1/chat/completions");
  });

  test("缺少凭据抛出带 ZETA_/环境变量提示的错误", async () => {
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      let message = "";
      try {
        await collect(createProviderStreamFn({ provider: "groq", model: "llama" })(request));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("GROQ_API_KEY");
      expect(message).toContain("ZETA_API_KEY");
    } finally {
      if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    }
  });

  test("未知 provider 抛出提示", async () => {
    let message = "";
    try {
      await collect(createProviderStreamFn({ provider: "nope", model: "x", apiKey: "dummy" })(request));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("UNKNOWN_PROVIDER");
  });

  test("非 2xx 响应抛带状态码且不泄露凭据", async () => {
    const fakeFetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    let message = "";
    try {
      await collect(
        createProviderStreamFn(
          { provider: "groq", model: "llama", apiKey: "super-secret" },
          fakeFetch
        )(request)
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("HTTP_401");
    expect(message).not.toContain("super-secret");
  });
});
