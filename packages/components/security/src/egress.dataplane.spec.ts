import { describe, expect, test } from "bun:test";
import {
  assertEgressAllowed,
  createDnsGate,
  createEgressGateway,
  createEgressPolicy,
  resolveEgressTarget,
  type EgressEnforcer,
} from "./egress";

describe("T-14 IF-12 数据面 egress 不可绕过", () => {
  test("resolveEgressTarget 补齐默认端口", () => {
    expect(resolveEgressTarget("https://api.example.com/v1")).toEqual({ host: "api.example.com", port: 443 });
    expect(resolveEgressTarget("http://api.example.com:8080/x")).toEqual({ host: "api.example.com", port: 8080 });
    expect(() => resolveEgressTarget("not a url")).toThrow("INVALID_EGRESS_URL");
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
