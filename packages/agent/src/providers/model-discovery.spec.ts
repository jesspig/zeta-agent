import { describe, expect, test } from "bun:test";
import { fetchModelIds } from "./model-discovery";

describe("GET /models 模型发现", () => {
  test("解析 data[].id 并去重，带 Bearer 认证", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const ids = await fetchModelIds({
      baseUrl: "https://api.test/v1/",
      apiKey: "k-1",
      egress: { allow: [{ host: "api.test", port: 443 }] },
    }, fakeFetch);
    expect(ids).toEqual(["m1", "m2"]);
    expect(captured.url).toBe("https://api.test/v1/models");
    expect(new Headers(captured.init?.headers).get("Authorization")).toBe("Bearer k-1");
  });

  test("非 2xx 抛错且不泄露凭据", async () => {
    const fakeFetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    let message = "";
    try {
      await fetchModelIds({
        baseUrl: "https://api.test/v1",
        apiKey: "secret",
        egress: { allow: [{ host: "api.test", port: 443 }] },
      }, fakeFetch);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MODELS_HTTP_401");
    expect(message).not.toContain("secret");
  });

  test("空列表抛错（不静默回退）", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    let message = "";
    try {
      await fetchModelIds({
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        egress: { allow: [{ host: "api.test", port: 443 }] },
      }, fakeFetch);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MODELS_EMPTY");
  });
});
