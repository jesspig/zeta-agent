import type { OpenAiConfig } from "@zeta-agent/agent";

export function resolveModelConfig(env: NodeJS.ProcessEnv): OpenAiConfig | null {
  const baseUrl = env.ZETA_BASE_URL;
  const apiKey = env.ZETA_API_KEY;
  const model = env.ZETA_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}
