import { describe, expect, test } from "bun:test";
import { createOAuthManager, createOAuthProvider } from "./oauth";

/** CR-25：登出后迟到的兑换结果不得恢复凭据。 */
describe("T-24 OAuth 登录代次", () => {
  test("logout 使在途 login 的迟到结果失效", async () => {
    let release!: (c: { token: string; expiresAt?: number }) => void;
    const provider = createOAuthProvider({
      id: "slow",
      authorizeUrl: "https://a.test/auth",
      tokenUrl: "https://a.test/token",
      clientId: "c",
      scopes: [],
      exchange: () => new Promise<{ token: string; expiresAt?: number }>((r) => { release = r; }),
    });
    const manager = createOAuthManager([provider]);
    const pending = manager.login("slow", { code: "x" });
    manager.logout("slow");
    release({ token: "LATE-TOKEN" });
    await pending;
    expect(manager.check("slow")).toBe(false);
    expect(manager.get("slow")).toBeUndefined();
  });
});
