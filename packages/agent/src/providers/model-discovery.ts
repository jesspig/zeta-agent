import { withCredentialFetch, type CredentialBoundaryRef } from "@zeta-agent/security";

export interface ModelDiscoveryConfig {
  readonly baseUrl: string;
  /** 直接模式：旧调用方仍可显式提供 key；边界模式由 broker 在 fetch 前注入。 */
  readonly apiKey?: string;
  /** 统一 credential boundary：明文只在 broker 中，config 序列化不泄露。 */
  readonly credentialBoundary?: CredentialBoundaryRef;
}

interface ModelsResponse {
  readonly data?: readonly { readonly id?: unknown }[];
}

/** 调用 OpenAI 兼容的 GET {baseUrl}/models，返回模型 id 列表。失败抛错，不做静默兜底。 */
export async function fetchModelIds(
  config: ModelDiscoveryConfig,
  fetchImpl: typeof fetch = fetch
): Promise<readonly string[]> {
  if (config.credentialBoundary === undefined && (config.apiKey === undefined || config.apiKey.length === 0)) {
    throw new Error("MODELS_CREDENTIAL_REQUIRED");
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
  const boundary = config.credentialBoundary;
  const gated = boundary === undefined
    ? fetchImpl
    : withCredentialFetch(boundary.broker, boundary.handle, fetchImpl);
  const response = await gated(url, {
    method: "GET",
    ...(boundary === undefined ? { headers: { Authorization: `Bearer ${config.apiKey}` } } : {}),
  });
  if (!response.ok) {
    const hint =
      response.status === 401
        ? "请检查 API Key"
        : response.status === 429
          ? "请求被限流"
          : response.status === 404
            ? "请检查 Base URL（端点 /models）"
            : "";
    throw new Error(`MODELS_HTTP_${response.status}${hint ? ` (${hint})` : ""}`);
  }
  const payload = (await response.json()) as ModelsResponse;
  const ids = (payload.data ?? [])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error("MODELS_EMPTY: /models 未返回任何模型 id");
  return [...new Set(ids)];
}
