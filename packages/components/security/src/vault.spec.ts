import { describe, expect, test } from "bun:test";
import { createCredentialVault, resolveAtBoundary, type SecretBinding } from "./vault";

const binding: SecretBinding = {
  scheme: "https",
  host: "api.example.com",
  path: "/v1",
  methods: ["POST"],
};

describe("T-21 CredentialVault", () => {
  test("issue 返回占位符，vault 不持有明文", () => {
    const vault = createCredentialVault();
    const secret = "sk-not-a-real-secret";
    const placeholder = vault.issue({ name: "apiKey", binding });

    expect(placeholder.token.startsWith("__zeta_secret_")).toBe(true);
    expect(placeholder.token.endsWith("__")).toBe(true);
    expect(placeholder.token.includes(secret)).toBe(false);
    expect(JSON.stringify(vault.issued).includes(secret)).toBe(false);
    expect(vault.bindingOf(placeholder)).toEqual(binding);
  });

  test("issue 校验失败抛异常", () => {
    const vault = createCredentialVault();
    expect(() => vault.issue({ name: "", binding })).toThrow("INVALID_CREDENTIAL_NAME");
    expect(() => vault.issue({ name: "key", binding: { ...binding, host: "" } })).toThrow("INVALID_CREDENTIAL_BINDING");
  });

  test("出口侧按绑定注入真实头，绑定不匹配即拒绝", () => {
    const vault = createCredentialVault();
    const placeholder = vault.issue({ name: "apiKey", binding });
    const broker = () => ({ Authorization: "Bearer boundary-only-value" });

    const headers = resolveAtBoundary(
      vault,
      placeholder,
      { url: "https://api.example.com/v1/chat", method: "POST" },
      broker
    );
    expect(headers.Authorization).toBe("Bearer boundary-only-value");

    expect(() =>
      resolveAtBoundary(vault, placeholder, { url: "https://evil.example/v1", method: "POST" }, broker)
    ).toThrow("CREDENTIAL_BINDING_MISMATCH");
    expect(() =>
      resolveAtBoundary(vault, placeholder, { url: "https://api.example.com/v1", method: "GET" }, broker)
    ).toThrow("CREDENTIAL_BINDING_MISMATCH");
  });
});
