import { createOutboundClient, egressRuleFromUrl, type OutboundClient } from "@zeta-agent/components";

/**
 * CLI/remote 的显式 allow 来源：用户配置的 baseUrl / endpoint 本身。
 * 端点缺失时直接抛错；无 allow 规则的出站客户端在 fetch 前抛配置错误。
 */
export function createConnectionOutbound(
  endpoint: string,
  fetchImpl: typeof fetch = globalThis.fetch
): OutboundClient {
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("REMOTE_ENDPOINT_REQUIRED");
  return createOutboundClient({
    egress: { allow: [egressRuleFromUrl(endpoint)] },
    fetch: fetchImpl,
  });
}

/** 无显式端点时的默认出站客户端：仅用于证明默认拒绝，不允许任何网络访问。 */
export function createDefaultDenyOutbound(fetchImpl: typeof fetch = globalThis.fetch): OutboundClient {
  return createOutboundClient({ egress: { allow: [] }, fetch: fetchImpl });
}
