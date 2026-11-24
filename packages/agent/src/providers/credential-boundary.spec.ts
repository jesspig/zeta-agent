import { describe, expect, test } from "bun:test";
import {
  createCredentialBroker,
  createEgressPolicy,
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
      { credentialBoundary: { broker, handle } },
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
});
