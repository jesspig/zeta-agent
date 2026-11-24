/** 真实 stdio MCP server fixture：每行一个 JSON-RPC 请求，回写一行响应。 */
const PROTOCOL = "2025-06-18";

interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function respond(message: Request): unknown {
  const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      return result({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: "real-fixture", version: "1.0.0" },
      });
    case "tools/list":
      return result({
        tools: [{
          name: "echo",
          description: "echo input",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          outputSchema: { type: "object", properties: { text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        }],
      });
    case "tools/call": {
      const params = message.params as { name: string; arguments: { text: string } };
      if (params.name !== "echo") return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "UNKNOWN_TOOL" } };
      return result({
        content: [{ type: "text", text: params.arguments.text }],
        structuredContent: { text: params.arguments.text },
      });
    }
    case "resources/list":
      return result({ resources: [{ uri: "file:///fixture.txt", name: "fixture" }] });
    case "prompts/list":
      return result({ prompts: [{ name: "greet" }] });
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "METHOD_NOT_FOUND" } };
  }
}

for await (const chunk of Bun.stdin.stream()) {
  const text = new TextDecoder().decode(chunk);
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const message = JSON.parse(line) as Request;
    await Bun.write(Bun.stdout, `${JSON.stringify(respond(message))}\n`);
  }
}
