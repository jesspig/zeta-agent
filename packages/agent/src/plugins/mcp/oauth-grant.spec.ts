import { describe, expect, test } from "bun:test";
import { createCredentialBroker } from "@zeta-agent/security";
import {
  createMcpOAuthGrantManager,
  type McpOAuthGrantSpec,
} from "./oauth-grant";

const SPEC: McpOAuthGrantSpec = {
  id: "srv-oauth",
  origin: "https://mcp.example.test",
  clientId: "zeta-client",
  scopes: ["tools:read", "tools:call"],
  tokenPath: "/oauth/token",
};

function setup(refreshImpl?: (signal?: AbortSignal) => Promise<{ token: string; ttlMs?: number }>) {
  const broker = createCredentialBroker();
  const refreshes: Array<{ signal?: AbortSignal }> = [];
  const manager = createMcpOAuthGrantManager({
    broker,
    exchange: async ({ code }) => ({ token: `token-${code === "code-1" ? 1 : code}`, ttlMs: 60_000 }),
    refresh: (signal) => {
      refreshes.push({ signal });
      return refreshImpl?.(signal) ?? Promise.resolve({ token: `token-${refreshes.length}`, ttlMs: 60_000 });
    },
  });
  return { broker, manager, refreshes };
}

describe("T-17 MCP OAuth grant 绑定/刷新/取消", () => {
  test("① grant 绑定 origin/client/scope，换 token 后仅对绑定目标可用", async () => {
    const { manager } = setup();
    const grant = await manager.login(SPEC, { code: "code-1" });
    expect(grant.origin).toBe(SPEC.origin);
    expect(grant.clientId).toBe(SPEC.clientId);
    expect(grant.scopes).toEqual(SPEC.scopes);

    const headers = manager.headers(grant, `${SPEC.origin}/oauth/token`, "POST");
    expect(headers.Authorization).toBe("Bearer token-1");

    expect(() => manager.headers(grant, "https://evil.test/oauth/token", "POST")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => manager.headers(grant, `${SPEC.origin}/oauth/token`, "GET")).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() => manager.headers(grant, `${SPEC.origin}/oauth/token`, "POST")).not.toThrow();

    const otherClient = { ...grant, clientId: "attacker" };
    expect(() => manager.headers(otherClient, `${SPEC.origin}/oauth/token`, "POST")).toThrow("MCP_OAUTH_BINDING_MISMATCH");
    const otherScope = { ...grant, scopes: ["admin"] };
    expect(() => manager.headers(otherScope, `${SPEC.origin}/oauth/token`, "POST")).toThrow("MCP_OAUTH_BINDING_MISMATCH");
  });

  test("② 串行 refresh：并发调用共享一次在途刷新，结果一致", async () => {
    let release!: (value: { token: string }) => void;
    const { manager, refreshes } = setup((signal) => {
      void signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const grant = await manager.login(SPEC, { code: "code-1" });
    const first = manager.refresh(grant);
    const second = manager.refresh(grant);
    await Promise.resolve();
    expect(refreshes).toHaveLength(1);
    release({ token: "refreshed" });
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ token: "refreshed" });
    expect(two).toMatchObject({ token: "refreshed" });
    expect(manager.headers(grant, `${SPEC.origin}/oauth/token`, "POST").Authorization).toBe("Bearer refreshed");
  });

  test("③ cancel 清理：取消在途 refresh 后迟到结果不提交，pending 清空可重试", async () => {
    let release!: (value: { token: string }) => void;
    const controller = new AbortController();
    const { manager, refreshes } = setup((signal) => {
      signal?.addEventListener("abort", () => release({ token: "LATE" }), { once: true });
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const grant = await manager.login(SPEC, { code: "code-1" });
    const pending = manager.refresh(grant, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("MCP_OAUTH_CANCELLED");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.headers(grant, `${SPEC.origin}/oauth/token`, "POST").Authorization).toBe("Bearer token-1");
    expect(manager.pendingCount).toBe(0);

    const retry = manager.refresh(grant);
    release({ token: "retry-token" });
    await expect(retry).resolves.toMatchObject({ token: "retry-token" });
    expect(refreshes).toHaveLength(2);
  });

  test("④ revoke 后取头失败；logout 阻断迟到刷新结果", async () => {
    const { manager } = setup();
    const grant = await manager.login(SPEC, { code: "code-1" });
    manager.revoke(grant);
    expect(() => manager.headers(grant, `${SPEC.origin}/oauth/token`, "POST")).toThrow("CREDENTIAL_REVOKED");
  });
});
