import { describe, expect, test } from "bun:test";
import {
  assertEgressAllowed,
  createDnsGate,
  createEgressGateway,
  createEgressPolicy,
  MAX_EGRESS_REDIRECTS,
  resolveEgressTarget,
  type EgressEnforcer,
} from "./egress";

describe("T-14 IF-12 数据面 egress 不可绕过", () => {
  test("resolveEgressTarget 补齐默认端口", () => {
    expect(resolveEgressTarget("https://api.example.com/v1")).toEqual({ host: "api.example.com", port: 443 });
    expect(resolveEgressTarget("http://api.example.com:8080/x")).toEqual({ host: "api.example.com", port: 8080 });
    expect(() => resolveEgressTarget("not a url")).toThrow("INVALID_EGRESS_URL");
    expect(() => resolveEgressTarget("ftp://a.test:21/x")).toThrow("INVALID_EGRESS_URL");
  });

  test("DNS 默认拒绝：未放行的主机不触发解析器，平台 deny 永远优先", async () => {
    const resolved: string[] = [];
    const resolver = (host: string): string => {
      resolved.push(host);
      return "203.0.113.1";
    };
    const deny = createDnsGate(createEgressPolicy(), resolver);
    let message = "";
    try {
      await deny.lookup("api.example.com");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DNS_DENIED");
    expect(resolved).toEqual([]);

    const allow = createDnsGate(createEgressPolicy({ allow: [{ host: "api.example.com" }] }), resolver);
    expect(await allow.lookup("api.example.com")).toBe("203.0.113.1");

    const overridden = createDnsGate(
      createEgressPolicy({
        allow: [{ host: "169.254.169.254" }],
        denyAlways: [{ host: "169.254.169.254" }],
      }),
      resolver
    );
    message = "";
    try {
      await overridden.lookup("169.254.169.254");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DNS_DENIED");
    expect(resolved).toEqual(["api.example.com"]);
  });

  test("gateway 默认拒绝、平台 deny 优先；放行目标才到达底层 fetch", async () => {
    const policy = createEgressPolicy({ allow: [{ host: "api.example.com", port: 443 }] });
    const calls: string[] = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;

    const gateway = createEgressGateway({ policy, fetch: baseFetch });
    let message = "";
    try {
      await gateway.fetch("https://evil.example/v1");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("EGRESS_DENIED");
    expect(calls).toEqual([]);

    await gateway.fetch("https://api.example.com/v1");
    expect(calls).toEqual(["https://api.example.com/v1"]);
    // 网关只暴露受策略约束的 fetch，不提供底层 fetch 的逃生口。
    expect(Object.keys(gateway).sort()).toEqual(["assert", "fetch", "policy"]);
    expect(() => assertEgressAllowed(policy, { host: "evil.example", port: 443 })).toThrow("EGRESS_DENIED");

    const denyPolicy = createEgressPolicy({
      allow: [{ host: "169.254.169.254", port: 80 }],
      denyAlways: [{ host: "169.254.169.254", port: 80 }],
    });
    const denyGateway = createEgressGateway({ policy: denyPolicy, fetch: baseFetch });
    message = "";
    try {
      await denyGateway.fetch("http://169.254.169.254/latest/meta-data");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("EGRESS_DENIED");
    expect(calls).toHaveLength(1);
  });

  test("sidecar/nftables 强制层按目标生效，任一层拒绝即整条链路失败", async () => {
    const seen: string[] = [];
    const enforcer = (name: string): EgressEnforcer => ({
      name,
      enforce: (target) => {
        seen.push(`${name}:${target.host}:${target.port}`);
      },
    });
    const rejecting: EgressEnforcer = {
      name: "nftables",
      enforce: () => {
        throw new Error("NFTABLES_DENIED");
      },
    };
    const policy = createEgressPolicy({ allow: [{ host: "api.example.com", port: 443 }] });
    const baseFetch = (async () => new Response("ok")) as unknown as typeof fetch;

    await createEgressGateway({
      policy,
      fetch: baseFetch,
      enforcers: [enforcer("sidecar"), enforcer("dns")],
    }).fetch("https://api.example.com/v1");
    expect(seen).toEqual(["sidecar:api.example.com:443", "dns:api.example.com:443"]);

    let message = "";
    try {
      await createEgressGateway({ policy, fetch: baseFetch, enforcers: [rejecting] }).fetch("https://api.example.com/v1");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("NFTABLES_DENIED");
  });
});

describe("T-11 手动重定向逐跳重验", () => {
  test("allowed → denied 跳转在第二跳 fetch 前被拒，enforcer/DNS 只覆盖已放行跳", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const resolved: string[] = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://deny.test/x" } });
    }) as unknown as typeof fetch;
    const policy = createEgressPolicy({ allow: [{ host: "first.test", port: 443 }] });
    const gateway = createEgressGateway({
      policy,
      fetch: baseFetch,
      dns: createDnsGate(policy, (host) => {
        resolved.push(host);
        return host;
      }),
      enforcers: [{
        name: "sidecar",
        enforce: (target) => seen.push(`${target.host}:${target.port}`),
      }],
    });

    await expect(gateway.fetch("https://first.test/start")).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toEqual(["https://first.test/start"]);
    expect(seen).toEqual(["first.test:443"]);
    expect(resolved).toEqual(["first.test"]);
  });

  test("allowed → allowed 逐跳放行，每跳都重新过 DNS 与 enforcer", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const resolved: string[] = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://first.test/start") {
        return new Response(null, { status: 302, headers: { location: "https://second.test/next" } });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const policy = createEgressPolicy({
      allow: [{ host: "first.test", port: 443 }, { host: "second.test", port: 443 }],
    });
    const gateway = createEgressGateway({
      policy,
      fetch: baseFetch,
      dns: createDnsGate(policy, (host) => {
        resolved.push(host);
        return host;
      }),
      enforcers: [{
        name: "sidecar",
        enforce: (target) => seen.push(target.host),
      }],
    });

    const response = await gateway.fetch("https://first.test/start");
    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["https://first.test/start", "https://second.test/next"]);
    expect(resolved).toEqual(["first.test", "second.test"]);
    expect(seen).toEqual(["first.test", "second.test"]);
  });

  test("跨 origin 清除 Authorization/Cookie 与绑定查询参数，保留普通参数", async () => {
    let secondHop: { url: string; authorization: string | null; cookie: string | null; keep: string | null } | undefined;
    const policy = createEgressPolicy({
      allow: [{ host: "a.test", port: 443 }, { host: "b.test", port: 443 }],
    });
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://a.test/")) {
        return new Response(null, { status: 302, headers: { location: "https://b.test/next?key=leaked&keep=1" } });
      }
      const headers = new Headers(init?.headers);
      secondHop = {
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        cookie: headers.get("cookie"),
        keep: new URL(url).searchParams.get("keep"),
      };
      return new Response("ok");
    }) as unknown as typeof fetch;
    const gateway = createEgressGateway({ policy, fetch: baseFetch });

    await gateway.fetch("https://a.test/start?key=secret&keep=1", {
      headers: { Authorization: "Bearer secret", Cookie: "sid=secret", "x-plain": "keep" },
    });
    expect(secondHop?.url).toBe("https://b.test/next?keep=1");
    expect(secondHop?.authorization).toBeNull();
    expect(secondHop?.cookie).toBeNull();
  });

  test("跳数上限与非 HTTP(S) 跳转都失败关闭", async () => {
    let calls = 0;
    const loopFetch = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "/loop" } });
    }) as unknown as typeof fetch;
    const policy = createEgressPolicy({ allow: [{ host: "a.test", port: 443 }] });
    await expect(createEgressGateway({ policy, fetch: loopFetch }).fetch("https://a.test/loop"))
      .rejects.toThrow("EGRESS_REDIRECT_LIMIT");
    expect(calls).toBe(MAX_EGRESS_REDIRECTS + 1);

    const schemeFetch = (async () => new Response(null, {
      status: 302,
      headers: { location: "file:///etc/passwd" },
    })) as unknown as typeof fetch;
    await expect(createEgressGateway({ policy, fetch: schemeFetch }).fetch("https://a.test/start"))
      .rejects.toThrow("EGRESS_REDIRECT_SCHEME");
  });

  test("Request 输入保留 method/headers/body，307 不降级为 GET", async () => {
    const seen: Array<{ method: string; keep: string | null; hasBody: boolean }> = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === "https://a.test/start") {
        return new Response(null, { status: 307, headers: { location: "https://a.test/next" } });
      }
      seen.push({
        method: init?.method ?? "GET",
        keep: new Headers(init?.headers).get("x-keep"),
        hasBody: init?.body !== undefined,
      });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const policy = createEgressPolicy({ allow: [{ host: "a.test", port: 443 }] });
    const gateway = createEgressGateway({ policy, fetch: baseFetch });
    await gateway.fetch(new Request("https://a.test/start", {
      method: "POST",
      headers: { "x-keep": "yes" },
      body: "payload",
    }));
    expect(seen).toEqual([{ method: "POST", keep: "yes", hasBody: true }]);
  });
});
