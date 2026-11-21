import type { OpenAiConfig } from "@zeta-agent/agent";

const REQUIRED_VARS = ["ZETA_BASE_URL", "ZETA_API_KEY", "ZETA_MODEL"] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number];

export type ConfigResolution =
  | { readonly kind: "configured"; readonly config: OpenAiConfig }
  | { readonly kind: "fallback"; readonly missing: readonly RequiredVar[] };

/** 读取模型配置；缺失任一变量时返回 fallback 并列出缺失项，供 CLI 明确提示。 */
export function resolveModelConfig(env: NodeJS.ProcessEnv): ConfigResolution {
  const values: Record<RequiredVar, string | undefined> = {
    ZETA_BASE_URL: env.ZETA_BASE_URL,
    ZETA_API_KEY: env.ZETA_API_KEY,
    ZETA_MODEL: env.ZETA_MODEL,
  };
  const missing = REQUIRED_VARS.filter((name) => {
    const value = values[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) return { kind: "fallback", missing };
  const baseUrl = values.ZETA_BASE_URL as string;
  return {
    kind: "configured",
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: values.ZETA_API_KEY as string,
      model: values.ZETA_MODEL as string,
    },
  };
}
