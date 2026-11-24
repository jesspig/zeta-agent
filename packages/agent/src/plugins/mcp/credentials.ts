import {
  assertEgressAllowed,
  type CredentialBoundaryRef,
  type EgressPolicy,
} from "@zeta-agent/security";
import { networkTargetOf, type McpServerConfig } from "./config";

/** 网络型 MCP server 的 egress 门禁：默认拒绝，平台 deny 永远压过用户 allow。 */
export function assertMcpEgress(policy: EgressPolicy, server: McpServerConfig): void {
  const target = networkTargetOf(server);
  if (target === undefined) return;
  assertEgressAllowed(policy, target);
}

/** MCP 出站请求在 transport 建立前经统一凭证边界取头，stdio server 无网络凭据。 */
export function mcpCredentialHeaders(
  options: CredentialBoundaryRef & { readonly server: McpServerConfig; readonly method?: string }
): Record<string, string> {
  const { broker, handle, server } = options;
  if (server.transport === "stdio") throw new Error("MCP_STDIO_NO_NETWORK_CREDENTIAL");
  return broker.resolve(handle, { url: server.url, method: options.method ?? "POST" });
}
