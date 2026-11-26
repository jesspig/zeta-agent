/**
 * daemon 传输门禁：非 loopback 必须 TLS + mTLS；loopback 明文只是显式开发选项。
 * 所有判定在绑定端口之前完成，失败关闭时不留下任何监听中的明文服务。
 */

export type TlsMaterial = string | Uint8Array;

export interface DaemonTlsConfig {
  readonly cert: TlsMaterial;
  readonly key: TlsMaterial;
  /** 校验客户端证书的 CA；非 loopback 必填。 */
  readonly ca?: TlsMaterial;
  readonly requestCert?: boolean;
  readonly rejectUnauthorized?: boolean;
  readonly passphrase?: string;
}

export interface TransportPolicyOptions {
  readonly host: string;
  readonly tls?: DaemonTlsConfig;
  readonly allowPlainLoopback?: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "ip6-localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function hasMaterial(value: TlsMaterial | undefined): boolean {
  if (typeof value === "string") return value.length > 0;
  return value instanceof Uint8Array && value.byteLength > 0;
}

/** 绑定前校验：不满足任何一条就直接抛错，绝不退化为明文监听。 */
export function assertTransportAllowed(options: TransportPolicyOptions): void {
  const { host, tls } = options;
  if (typeof host !== "string" || host.length === 0) throw new Error("DAEMON_HOST_REQUIRED");
  if (tls !== undefined) {
    if (!hasMaterial(tls.cert) || !hasMaterial(tls.key)) throw new Error("TLS_CERT_KEY_REQUIRED");
    if (!isLoopbackHost(host)) {
      if (!hasMaterial(tls.ca)) throw new Error("MTLS_CA_REQUIRED_FOR_NON_LOOPBACK");
      if (tls.requestCert !== true) throw new Error("MTLS_REQUIRED_FOR_NON_LOOPBACK");
      if (tls.rejectUnauthorized === false) throw new Error("MTLS_UNAUTHORIZED_CLIENT_FORBIDDEN");
    }
    return;
  }
  if (!isLoopbackHost(host)) throw new Error("TLS_REQUIRED_FOR_NON_LOOPBACK");
  if (options.allowPlainLoopback !== true) throw new Error("PLAIN_LOOPBACK_NOT_ALLOWED");
}

/** 映射为 Bun.serve / Bun.listen 的 TLS 配置；mTLS 服务端策略保持 fail-closed。 */
export function resolveBunTls(tls: DaemonTlsConfig | undefined): Record<string, unknown> | undefined {
  if (tls === undefined) return undefined;
  return {
    cert: tls.cert,
    key: tls.key,
    ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
    requestCert: tls.requestCert === true,
    rejectUnauthorized: tls.rejectUnauthorized !== false,
    ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
  };
}

export function transportScheme(tls: DaemonTlsConfig | undefined): "http" | "https" {
  return tls === undefined ? "http" : "https";
}
