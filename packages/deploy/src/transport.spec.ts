import { describe, expect, test } from "bun:test";
import {
  assertTransportAllowed,
  isLoopbackHost,
  resolveBunTls,
  transportScheme,
  type DaemonTlsConfig,
} from "./transport";

const tls: DaemonTlsConfig = {
  cert: "server-cert",
  key: "server-key",
  ca: "client-ca",
  requestCert: true,
  rejectUnauthorized: true,
};

function errorOf(action: () => void): string {
  try {
    action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("T-16 daemon 传输门禁", () => {
  test("仅 127.0.0.0/8、::1、localhost 被视为 loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.42.0.9")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("198.51.100.7")).toBe(false);
    expect(isLoopbackHost("daemon.internal")).toBe(false);
  });

  test("明文非 loopback 必须在绑定前拒绝；loopback 明文必须显式开启", () => {
    expect(errorOf(() => assertTransportAllowed({ host: "198.51.100.7" }))).toBe("TLS_REQUIRED_FOR_NON_LOOPBACK");
    expect(errorOf(() => assertTransportAllowed({ host: "0.0.0.0", allowPlainLoopback: true }))).toBe(
      "TLS_REQUIRED_FOR_NON_LOOPBACK"
    );
    expect(errorOf(() => assertTransportAllowed({ host: "127.0.0.1" }))).toBe("PLAIN_LOOPBACK_NOT_ALLOWED");
    expect(() => assertTransportAllowed({ host: "127.0.0.1", allowPlainLoopback: true })).not.toThrow();
  });

  test("非 loopback TLS 必须同时具备 CA、requestCert 且不得关闭校验", () => {
    expect(errorOf(() => assertTransportAllowed({ host: "198.51.100.7", tls: { cert: "c", key: "k" } }))).toBe(
      "MTLS_CA_REQUIRED_FOR_NON_LOOPBACK"
    );
    expect(
      errorOf(() =>
        assertTransportAllowed({ host: "198.51.100.7", tls: { cert: "c", key: "k", ca: "ca" } })
      )
    ).toBe("MTLS_REQUIRED_FOR_NON_LOOPBACK");
    expect(
      errorOf(() =>
        assertTransportAllowed({
          host: "198.51.100.7",
          tls: { cert: "c", key: "k", ca: "ca", requestCert: true, rejectUnauthorized: false },
        })
      )
    ).toBe("MTLS_UNAUTHORIZED_CLIENT_FORBIDDEN");
    expect(() => assertTransportAllowed({ host: "198.51.100.7", tls })).not.toThrow();
  });

  test("Bun TLS 配置保留 mTLS 正向策略与 scheme", () => {
    const resolved = resolveBunTls(tls) as Record<string, unknown>;
    expect(resolved).toMatchObject({
      cert: "server-cert",
      key: "server-key",
      ca: "client-ca",
      requestCert: true,
      rejectUnauthorized: true,
    });
    expect(transportScheme(tls)).toBe("https");
    expect(transportScheme(undefined)).toBe("http");
    expect(resolveBunTls(undefined)).toBeUndefined();
  });
});
