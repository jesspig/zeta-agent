import { describe, expect, test } from "bun:test";
import {
  createCredentialBroker,
  withCredentialFetch,
  type CredentialBinding,
} from "./credentials";

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
});
