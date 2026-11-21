import { describe, expect, test } from "bun:test";
import type { AgentStreamRequest } from "../facade";
import { encodeImage, imageMessage, type ImageSource } from "./image";
import { createImageAwareStreamFn } from "./image-stream";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZkAAAAASUVORK5CYII=";

describe("图片输入（T-17）", () => {
  test("base64 数据编码为 data URL", () => {
    const encoded = encodeImage({ data: tinyPng, mimeType: "image/png" });
    expect(encoded.dataUrl).toBe(`data:image/png;base64,${tinyPng}`);
    expect(encoded.mimeType).toBe("image/png");
  });

  test("URL 型图片保留原 URL", () => {
    const encoded = encodeImage({ url: "https://example.test/a.png", mimeType: "image/png" });
    expect(encoded.dataUrl).toBe("https://example.test/a.png");
    expect(encoded.mimeType).toBe("image/png");
  });

  test("缺少数据源抛出提示", () => {
    let message = "";
    try {
      encodeImage({ mimeType: "image/png" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("IMAGE_SOURCE_REQUIRED");
  });

  test("imageMessage 产出多模态 content 部件", () => {
    const msg = imageMessage("看这张图", { data: tinyPng, mimeType: "image/png" });
    expect(msg.role).toBe("user");
    const content = msg.content as readonly { readonly type: string; readonly text?: string }[];
    expect(content[0]).toEqual({ type: "text", text: "看这张图" });
    expect(content[1]?.type).toBe("image_url");
  });

  test("图片进入 StreamFn 请求（OpenAI 兼容 image_url 格式）", async () => {
    let captured: { init?: RequestInit } = {};
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = { init };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const request: AgentStreamRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "描述一下" },
            { type: "image", source: { data: tinyPng, mimeType: "image/png" } as ImageSource },
          ],
        },
      ],
    };
    const out: string[] = [];
    for await (const chunk of createImageAwareStreamFn(
      { baseUrl: "https://img.test/v1", apiKey: "dummy", model: "gpt-4o" },
      fakeFetch
    )(request)) {
      out.push(chunk);
    }
    expect(out).toEqual([]);
    const body = JSON.parse(String(captured.init?.body));
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "描述一下" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${tinyPng}`);
  });
});
