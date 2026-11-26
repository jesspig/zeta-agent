import { describe, expect, test } from "bun:test";
import {
  createCredentialBroker,
  createEgressPolicy,
  createOutboundClient,
  type CredentialBinding,
  type CredentialBroker,
  type CredentialHandle,
} from "@zeta-agent/security";
import { fetchModelIds } from "./model-discovery";
import { createProviderStreamFn } from "./dispatch";
import { fetchImageBytes } from "./image";
import { assertMcpEgress, mcpCredentialHeaders } from "../plugins/mcp/credentials";
import type { McpServerConfig } from "../plugins/mcp/config";

const binding: CredentialBinding = {
  scheme: "https",
  host: "api.test",
  pathSegments: ["v1"],
  methods: ["POST", "GET"],
};

function boundary(): { broker: CredentialBroker; handle: CredentialHandle; secret: string } {
  const secret = "sk-unified-boundary-only";
  const broker = createCredentialBroker({ now: () => 0 });
  const handle = broker.issue({ name: "k", binding, secret });
  return { broker, handle, secret };
}

function okFetch(calls: Array<{ url: string; headers: Headers }>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("T-14 IF-11 统一 credential boundary", () => {
  test("model discovery 经边界注入；明文不进 config，绑定不符在 fetch 前失败", async () => {
    const { broker, handle, secret } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const config = {
      baseUrl: "https://api.test/v1/",
      credentialBoundary: { broker, handle },
      egress: { allow: [{ host: "api.test", port: 443 }] },
    };
    expect(JSON.stringify(config).includes(secret)).toBe(false);
    const jsonFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m1" }, { id: "m2" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ids = await fetchModelIds(config, jsonFetch);
    expect(ids).toEqual(["m1", "m2"]);
    expect(calls[0]!.headers.get("Authorization")).toBe(`Bearer ${secret}`);
    broker.invalidateAll();
    let message = "";
    try {
      await fetchModelIds(config, jsonFetch);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CREDENTIAL_STALE");
    expect(calls).toHaveLength(1);
  });

  test("provider dispatch 经边界注入，config 无明文", async () => {
    const { broker, handle, secret } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const stream = createProviderStreamFn(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://api.test/v1",
        credentialBoundary: { broker, handle },
        egress: { allow: [{ host: "api.test", port: 443 }] },
      },
      okFetch(calls)
    );
    for await (const _chunk of stream({ messages: [] })) void _chunk;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("Authorization")).toBe(`Bearer ${secret}`);
  });

  test("image 远程抓取经边界注入；绑定错误不触发 fetch", async () => {
    const { broker, handle, secret } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const bytes = await fetchImageBytes(
      { url: "https://api.test/v1/pic.png", mimeType: "image/png" },
      { credentialBoundary: { broker, handle }, egress: { allow: [{ host: "api.test", port: 443 }] } },
      okFetch(calls)
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(calls[0]!.headers.get("Authorization")).toBe(`Bearer ${secret}`);
    let message = "";
    try {
      await fetchImageBytes(
        { url: "https://evil.test/v1/pic.png", mimeType: "image/png" },
        { credentialBoundary: { broker, handle } },
        okFetch(calls)
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CREDENTIAL_BINDING_MISMATCH");
    expect(calls).toHaveLength(1);
  });

  test("image 数据面 egress 不可绕过：未放行目标在 fetch 前拒绝，平台 deny 压过 allow", async () => {
    const { broker, handle } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const source = { url: "https://api.test/v1/pic.png", mimeType: "image/png" };
    let message = "";
    try {
      await fetchImageBytes(
        source,
        { credentialBoundary: { broker, handle }, egress: { policy: createEgressPolicy() } },
        okFetch(calls)
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("EGRESS_DENIED");
    expect(calls).toEqual([]);

    message = "";
    try {
      await fetchImageBytes(
        source,
        {
          credentialBoundary: { broker, handle },
          egress: {
            policy: createEgressPolicy({
              allow: [{ host: "api.test", port: 443 }],
              denyAlways: [{ host: "api.test", port: 443 }],
            }),
          },
        },
        okFetch(calls)
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("EGRESS_DENIED");
    expect(calls).toEqual([]);
  });

  test("MCP 网络 server 经边界取凭据，egress 默认拒绝且平台 deny 优先", () => {
    const { broker, handle, secret } = boundary();
    const server: McpServerConfig = {
      name: "remote",
      transport: "streamable-http",
      url: "https://api.test/v1/mcp",
    };
    expect(() => assertMcpEgress(createEgressPolicy(), server)).toThrow("EGRESS_DENIED");
    expect(() =>
      assertMcpEgress(
        createEgressPolicy({
          allow: [{ host: "api.test", port: 443 }],
          denyAlways: [{ host: "api.test", port: 443 }],
        }),
        server
      )
    ).toThrow("EGRESS_DENIED");
    assertMcpEgress(createEgressPolicy({ allow: [{ host: "api.test", port: 443 }] }), server);
    const headers = mcpCredentialHeaders({ broker, handle, server });
    expect(headers.Authorization).toBe(`Bearer ${secret}`);
    expect(() =>
      mcpCredentialHeaders({ broker, handle, server: { ...server, url: "https://evil.test/v1/mcp" } })
    ).toThrow("CREDENTIAL_BINDING_MISMATCH");
  });

  test("统一出站客户端：无 allow 规则时 discovery/provider/image 都在 fetch 前配置错误", async () => {
    const { broker, handle } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const baseFetch = okFetch(calls);
    const denied = createOutboundClient({ egress: { allow: [] }, fetch: baseFetch });

    await expect(fetchModelIds({
      baseUrl: "https://api.test/v1",
      credentialBoundary: { broker, handle },
      outbound: denied,
    }, baseFetch)).rejects.toThrow("EGRESS_ALLOW_REQUIRED");

    const stream = createProviderStreamFn({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.test/v1",
      credentialBoundary: { broker, handle },
      outbound: denied,
    }, baseFetch);
    await expect((async () => {
      for await (const _chunk of stream({ messages: [] })) void _chunk;
    })()).rejects.toThrow("EGRESS_ALLOW_REQUIRED");

    await expect(fetchImageBytes(
      { url: "https://api.test/v1/pic.png", mimeType: "image/png" },
      { credentialBoundary: { broker, handle }, outbound: denied },
      baseFetch
    )).rejects.toThrow("EGRESS_ALLOW_REQUIRED");
    expect(calls).toEqual([]);
  });

  test("注入裸 fetchImpl 但无 allow：discovery/provider/image 全部失败关闭且不触达 transport", async () => {
    const calls: string[] = [];
    const bareFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const withoutAllow = { baseUrl: "https://api.test/v1", apiKey: "k" };

    await expect(fetchModelIds(withoutAllow, bareFetch)).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    const stream = createProviderStreamFn({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
    }, bareFetch);
    await expect((async () => {
      for await (const _chunk of stream({ messages: [] })) void _chunk;
    })()).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    await expect(fetchImageBytes(
      { url: "https://api.test/v1/pic.png", mimeType: "image/png" },
      {},
      bareFetch
    )).rejects.toThrow(/EGRESS_ALLOW_REQUIRED|EGRESS_DENIED/);
    expect(calls).toEqual([]);
  });

  test("注入裸 fetchImpl 且配置 allow：transport 真正被调用并受逐跳门禁约束", async () => {
    const calls: string[] = [];
    let redirectNext = true;
    const bareFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (redirectNext) {
        redirectNext = false;
        return new Response(null, { status: 302, headers: { location: "https://deny.test/x" } });
      }
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const allow = { allow: [{ host: "api.test", port: 443 }] };

    redirectNext = true;
    await expect(fetchModelIds({ baseUrl: "https://api.test/v1", apiKey: "k", egress: allow }, bareFetch))
      .rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(1);
    const stream = createProviderStreamFn({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      egress: allow,
    }, bareFetch);
    redirectNext = true;
    await expect((async () => {
      for await (const _chunk of stream({ messages: [] })) void _chunk;
    })()).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(2);
    redirectNext = true;
    await expect(fetchImageBytes(
      { url: "https://api.test/v1/pic.png", mimeType: "image/png" },
      { egress: allow },
      bareFetch
    )).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(3);

    // 至少三跳全部由注入的 transport 承载，且未跟随到未放行的 deny.test。
    expect(calls.filter((url) => url.includes("api.test"))).toHaveLength(3);
    expect(calls.some((url) => url.includes("deny.test"))).toBe(false);
  });

  test("显式 allow 下 discovery/provider/image 共用同一出站入口并注入凭证", async () => {
    const { broker, handle, secret } = boundary();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const allowed = createOutboundClient({
      egress: { allow: [{ host: "api.test", port: 443 }] },
      fetch: baseFetch,
    });

    const ids = await fetchModelIds({
      baseUrl: "https://api.test/v1",
      credentialBoundary: { broker, handle },
      outbound: allowed,
    }, baseFetch);
    expect(ids.length).toBeGreaterThan(0);
    const stream = createProviderStreamFn({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.test/v1",
      credentialBoundary: { broker, handle },
      outbound: allowed,
    }, baseFetch);
    for await (const _chunk of stream({ messages: [] })) void _chunk;
    await fetchImageBytes(
      { url: "https://api.test/v1/pic.png", mimeType: "image/png" },
      { credentialBoundary: { broker, handle }, outbound: allowed },
      baseFetch
    );
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers.get("Authorization")).toBe(`Bearer ${secret}`);
  });
});
