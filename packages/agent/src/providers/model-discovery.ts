export interface ModelDiscoveryConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface ModelsResponse {
  readonly data?: readonly { readonly id?: unknown }[];
}

/** 调用 OpenAI 兼容的 GET {baseUrl}/models，返回模型 id 列表。失败抛错，不做静默兜底。 */
export async function fetchModelIds(
  config: ModelDiscoveryConfig,
  fetchImpl: typeof fetch = fetch
): Promise<readonly string[]> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.apiKey}` },
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
