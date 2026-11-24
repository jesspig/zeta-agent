import { defineKey } from "@zeta-agent/framework";

const MCP_SERVERS_KEY_NAME = "@zeta-agent/mcp:servers";

/** MCP server 配置的 coeffect 键：provider 变更后注入该键的 fiber 会被重激活。 */
export const mcpServersKey = defineKey<readonly McpServerConfig[]>(MCP_SERVERS_KEY_NAME);

export type McpTransportKind = "stdio" | "sse" | "streamable-http";

interface McpServerBase {
  readonly name: string;
}

export interface McpStdioServer extends McpServerBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface McpNetworkServer extends McpServerBase {
  readonly transport: "sse" | "streamable-http";
  readonly url: string;
}

export type McpServerConfig = McpStdioServer | McpNetworkServer;

/** 将 server/tool 段规范为工具名安全字符，避免三段式被分隔符或特殊字符混淆。 */
function normalizeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized.length === 0) throw new Error("MCP_NAME_SEGMENT_EMPTY");
  return normalized;
}

/** 三段式工具名：mcp__<server>__<tool>。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeSegment(server)}__${normalizeSegment(tool)}`;
}

/** 网络型 server 的 egress 目标；stdio 无网络目标，返回 undefined。 */
export function networkTargetOf(server: McpServerConfig): { readonly host: string; readonly port: number } | undefined {
  if (server.transport === "stdio") return undefined;
  const url = new URL(server.url);
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host: url.hostname, port };
}

/** 未显式声明 readOnlyHint 的 MCP 工具一律视作发射类，交给 facade 的 withhold 路径。 */
export function isEmissionMcpTool(tool: { readonly annotations?: { readonly readOnlyHint?: boolean } }): boolean {
  return tool.annotations?.readOnlyHint !== true;
}
