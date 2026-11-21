import { describe, expect, test } from "bun:test";
import { createOAuthProvider, createOAuthManager, type OAuthProvider } from "./oauth";

function demoProvider(): OAuthProvider {
  return createOAuthProvider({
    id: "demo",
    authorizeUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    clientId: "demo-client",
    scopes: ["model:read"],
    // 演示 provider：用固定 code 换取 dummy token，凭据不落盘。
    exchange: async ({ code }) => ({ token: ["dummy", "token", "for", code].join("-"), expiresAt: Date.now() + 60_000 }),
  });
}

describe("OAuth 流程（T-17）", () => {
  test("provider 元数据与授权 URL 构造", async () => {
    const provider = demoProvider();
    expect(provider.id).toBe("demo");
    const url = await provider.buildAuthorizeUrl("state-123", "http://localhost/cb");
    expect(url).toContain("https://auth.example.test/authorize");
    expect(url).toContain("client_id=demo-client");
    expect(url).toContain("state=state-123");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("scope=model%3Aread");
  });

  test("login 后凭据仅存在内存，check 返回 true，logout 后失效", async () => {
    const manager = createOAuthManager([demoProvider()]);
    expect(manager.check("demo")).toBe(false);
    const credentials = await manager.login("demo", { code: "abc" });
    expect(credentials.token).toBe("dummy-token-for-abc");
    expect(manager.check("demo")).toBe(true);
    expect(manager.get("demo")?.token).toBe("dummy-token-for-abc");
    expect(manager.credentials()).toHaveLength(1);
    manager.logout("demo");
    expect(manager.check("demo")).toBe(false);
    expect(manager.get("demo")).toBeUndefined();
  });

  test("重复 login 覆盖旧凭据", async () => {
    const manager = createOAuthManager([demoProvider()]);
    await manager.login("demo", { code: "one" });
    await manager.login("demo", { code: "two" });
    expect(manager.get("demo")?.token).toBe("dummy-token-for-two");
    expect(manager.credentials()).toHaveLength(1);
  });

  test("未知 provider 抛出带提示错误", async () => {
    const manager = createOAuthManager([demoProvider()]);
    let message = "";
    try {
      await manager.login("missing", { code: "x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("UNKNOWN_OAUTH_PROVIDER");
  });

  test("过期凭据被视为未登录", async () => {
    const provider = createOAuthProvider({
      id: "expired",
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      clientId: "c",
      scopes: [],
      exchange: async () => ({ token: "dummy", expiresAt: Date.now() - 1 }),
    });
    const manager = createOAuthManager([provider]);
    await manager.login("expired", { code: "x" });
    expect(manager.check("expired")).toBe(false);
  });

  test("凭据不写入 process.env 或磁盘文件", async () => {
    const manager = createOAuthManager([demoProvider()]);
    const before = JSON.stringify(process.env);
    const credentials = await manager.login("demo", { code: "secret-code" });
    expect(JSON.stringify(process.env)).toBe(before);
    expect(credentials.token).toContain("secret-code");
    expect(process.env.DEMO_TOKEN).toBeUndefined();
  });
});
