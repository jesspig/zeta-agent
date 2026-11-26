import { describe, expect, test } from "bun:test";
import {
  createCredentialBroker,
  withCredentialFetch,
  type CredentialBinding,
} from "./credentials";
import { createOutboundClient } from "./outbound";

const binding: CredentialBinding = {
  scheme: "https",
  host: "api.example.com",
  port: 443,
  pathSegments: ["v1"],
  methods: ["POST"],
};

describe("T-14 IF-11 CredentialBroker", () => {
  test("placeholder 不含明文，issued/序列化快照泄露扫描为空", () => {
    const secret = "sk-test-only-credential-9f3c";
    let now = 1000;
    const broker = createCredentialBroker({ now: () => now, headerName: "x-api-key" });
    const handle = broker.issue({ name: "apiKey", binding, secret, ttlMs: 500 });

    expect(handle.token.startsWith("__zeta_cred_")).toBe(true);
    for (const text of [
      JSON.stringify(handle),
      JSON.stringify(broker.handles),
      String(broker.revision),
      JSON.stringify(broker.status(handle)),
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
    expect(JSON.stringify(broker).includes(secret)).toBe(false);
    expect(broker.resolve(handle, { url: "https://api.example.com/v1/chat", method: "POST" })).toEqual({
      "x-api-key": secret,
    });
  });

  test("origin / path segment / method 绑定：分段边界与端口都生效", () => {
    const broker = createCredentialBroker({ now: () => 0 });
    const handle = broker.issue({ name: "k", binding, secret: "s" });
    const resolve = (url: string, method: string): void => {
      broker.resolve(handle, { url, method });
    };

    expect(() => resolve("https://api.example.com/v1/chat", "POST")).not.toThrow();
    expect(() => resolve("https://api.example.com/v1", "POST")).not.toThrow();
    // path segment 边界：/v10 与 /v1evil 不得命中 /v1。
    expect(() => resolve("https://api.example.com/v10/chat", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("https://api.example.com/v1evil", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("http://api.example.com/v1", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("https://evil.example/v1", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("https://api.example.com:8443/v1", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("https://api.example.com/v1", "GET")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => resolve("not a url", "POST")).toThrow("INVALID_CREDENTIAL_URL");
  });

  test("TTL 到期、显式撤销、轮换 revision 都使旧 handle 失效", () => {
    let now = 1000;
    const broker = createCredentialBroker({ now: () => now });
    const ttl = broker.issue({ name: "ttl", binding, secret: "a", ttlMs: 100 });
    expect(broker.status(ttl)).toBe("active");
    now = 1101;
    expect(broker.status(ttl)).toBe("expired");
    expect(() => broker.resolve(ttl, { url: "https://api.example.com/v1", method: "POST" })).toThrow("CREDENTIAL_EXPIRED");

    const live = broker.issue({ name: "live", binding, secret: "b" });
    expect(broker.status(live)).toBe("active");
    broker.revoke("live");
    expect(broker.status(live)).toBe("revoked");
    expect(() => broker.resolve(live, { url: "https://api.example.com/v1", method: "POST" })).toThrow("CREDENTIAL_REVOKED");

    const rotated = broker.issue({ name: "rot", binding, secret: "c" });
    const revisionBefore = broker.revision;
    const next = broker.rotate("rot");
    expect(broker.revision).toBe(revisionBefore + 1);
    expect(next.revision).toBe(broker.revision);
    expect(broker.status(rotated)).toBe("stale");
    expect(() => broker.resolve(rotated, { url: "https://api.example.com/v1", method: "POST" })).toThrow("CREDENTIAL_STALE");
    expect(broker.resolve(next, { url: "https://api.example.com/v1", method: "POST" }).Authorization).toBe("Bearer c");
  });

  test("invalidateAll 提升全局 revision，所有旧 handle 立即失效", () => {
    const broker = createCredentialBroker({ now: () => 0 });
    const a = broker.issue({ name: "a", binding, secret: "a" });
    const b = broker.issue({ name: "b", binding, secret: "b" });
    broker.invalidateAll();
    expect(broker.status(a)).toBe("stale");
    expect(broker.status(b)).toBe("stale");
    expect(() => broker.resolve(a, { url: "https://api.example.com/v1", method: "POST" })).toThrow("CREDENTIAL_STALE");
    const c = broker.issue({ name: "c", binding, secret: "c" });
    expect(broker.resolve(c, { url: "https://api.example.com/v1", method: "POST" }).Authorization).toBe("Bearer c");
  });

  test("跨 broker 的 handle 不能被解析", () => {
    const a = createCredentialBroker({ now: () => 0 });
    const b = createCredentialBroker({ now: () => 0 });
    const ha = a.issue({ name: "k", binding, secret: "a" });
    expect(b.status(ha)).toBe("unknown");
    expect(() => b.resolve(ha, { url: "https://api.example.com/v1", method: "POST" })).toThrow("UNKNOWN_CREDENTIAL");
  });

  test("withCredentialFetch 仅在 fetch 边界注入凭据，错误请求在 fetch 前失败", () => {
    const broker = createCredentialBroker({ now: () => 0 });
    const handle = broker.issue({ name: "k", binding, secret: "boundary-secret" });
    const calls: Array<{ url: string; headers: Headers }> = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("ok");
    }) as unknown as typeof fetch;

    const gated = withCredentialFetch(broker, handle, baseFetch);
    void gated("https://api.example.com/v1/chat", { method: "POST" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer boundary-secret");

    expect(() => gated("https://evil.example/v1", { method: "POST" })).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(calls).toHaveLength(1);
  });

  test("withCredentialFetch 正确处理 Request 输入的 method/headers/url", async () => {
    const broker = createCredentialBroker({ now: () => 0 });
    const handle = broker.issue({ name: "k", binding, secret: "request-secret" });
    const seen: Array<{ url: string; method: string; keep: string | null; authorization: string | null }> = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      seen.push({
        url: request.url,
        method: request.method,
        keep: request.headers.get("x-keep"),
        authorization: request.headers.get("authorization"),
      });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const gated = withCredentialFetch(broker, handle, baseFetch);

    await gated(new Request("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "x-keep": "yes" },
    }));
    expect(seen).toEqual([{
      url: "https://api.example.com/v1/chat",
      method: "POST",
      keep: "yes",
      authorization: "Bearer request-secret",
    }]);

    // Request 自身的 method 参与绑定校验，不能被默认 GET 掩盖。
    expect(() => gated(new Request("https://api.example.com/v1/chat", { method: "GET" })))
      .toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(seen).toHaveLength(1);
  });

  test("handle 冻结且权威副本不受外部篡改", () => {
    let now = 1000;
    const broker = createCredentialBroker({ now: () => now });
    const handle = broker.issue({ name: "ttl", binding, secret: "s", ttlMs: 100 });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(() => {
      (handle as { expiresAt?: number }).expiresAt = 1;
    }).toThrow();

    // 副本带伪造的 revision/expiresAt 时，状态仍以 broker 内部 handle 为准。
    const tampered = { ...handle, revision: 999, expiresAt: 0 };
    expect(broker.status(tampered)).toBe("active");
    expect(broker.resolve(tampered, { url: "https://api.example.com/v1", method: "POST" })).toEqual({
      Authorization: "Bearer s",
    });
    now = 1101;
    expect(broker.status(tampered)).toBe("expired");
    expect(() => broker.resolve(tampered, { url: "https://api.example.com/v1", method: "POST" }))
      .toThrow("CREDENTIAL_EXPIRED");

    const snapshot = broker.handles[0]!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { revision?: number }).revision = 999;
    }).toThrow();
    expect(broker.handles[0]!.revision).toBe(0);
  });

  test("preconnect 不透过凭证边界或统一出站客户端", async () => {
    let preconnectCalls = 0;
    const baseFetch = Object.assign(
      (async () => new Response("ok")) as unknown as typeof fetch,
      { preconnect: () => { preconnectCalls += 1; } }
    );
    const broker = createCredentialBroker({ now: () => 0 });
    const handle = broker.issue({ name: "k", binding, secret: "s" });
    const gated = withCredentialFetch(broker, handle, baseFetch);
    expect((gated as { preconnect?: unknown }).preconnect).toBeUndefined();

    const outbound = createOutboundClient({
      egress: { allow: [{ host: "api.example.com", port: 443 }] },
      fetch: baseFetch,
      credential: { broker, handle },
    });
    expect((outbound.fetch as { preconnect?: unknown }).preconnect).toBeUndefined();
    expect(preconnectCalls).toBe(0);
    await outbound.fetch("https://api.example.com/v1/chat", { method: "POST" });
    expect(preconnectCalls).toBe(0);
  });

  test("统一出站客户端：无 allow 规则在 fetch 前抛配置错误，显式 allow 才联网", async () => {
    const calls: string[] = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;
    const denied = createOutboundClient({ egress: { allow: [] }, fetch: baseFetch });
    await expect(denied.fetch("https://api.example.com/v1")).rejects.toThrow("EGRESS_ALLOW_REQUIRED");
    expect(calls).toEqual([]);

    const allowed = createOutboundClient({
      egress: { allow: [{ host: "api.example.com", port: 443 }] },
      fetch: baseFetch,
    });
    expect((await allowed.fetch("https://api.example.com/v1")).ok).toBe(true);
    expect(calls).toEqual(["https://api.example.com/v1"]);
    await expect(allowed.fetch("https://evil.example/v1")).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toHaveLength(1);
  });
});
