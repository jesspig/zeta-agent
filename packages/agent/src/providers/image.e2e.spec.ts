import { describe, expect, test } from "bun:test";
import { imageMessage } from "./image";
import { createImageAwareStreamFn } from "./image-stream";

/** CR-27：imageMessage 产出的消息必须能被 image stream 正确序列化，不丢图。 */
describe("T-26 多模态端到端序列化", () => {
  test("imageMessage 的输出进入请求体保留 image_url", async () => {
    let body: { messages?: Array<{ content?: Array<{ type?: string; image_url?: { url: string } }> }> } = {};
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const msg = imageMessage("describe", { url: "https://img.test/a.png", mimeType: "image/png" });
    await Array.fromAsync(
      createImageAwareStreamFn({ baseUrl: "https://api.test/v1", apiKey: "k", model: "m" }, fakeFetch)({
        messages: [msg as never],
      }),
    );
    const parts = body.messages?.[0]?.content ?? [];
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.includes("img.test"))).toBe(true);
  });
});
