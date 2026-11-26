import {
  createRemoteClient,
  createStdoutWriter,
  type StdoutWriter,
} from "@zeta-agent/deploy";
import type { CliArgs } from "./args";
import { createConnectionOutbound } from "./connection";

function linesFromPrompt(args: CliArgs): string[] {
  return args.prompt === undefined
    ? []
    : args.prompt.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * remote 模式：把每行 JSON-RPC 帧发给远端 daemon，响应只写 stdout writer，
 * 连接/解析诊断只写 stderr，退出前 flush。
 */
export async function executeRemoteFrames(
  args: CliArgs,
  writer: StdoutWriter,
  lines: readonly string[] = linesFromPrompt(args),
  fetchImpl?: typeof fetch
): Promise<number> {
  const endpoint = args.endpoint ?? process.env.ZETA_REMOTE_ENDPOINT;
  const token = args.token ?? process.env.ZETA_DAEMON_TOKEN;
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("REMOTE_ENDPOINT_REQUIRED");
  if (typeof token !== "string" || token.length === 0) throw new Error("REMOTE_TOKEN_REQUIRED");
  const outbound = createConnectionOutbound(endpoint, fetchImpl ?? globalThis.fetch);
  const client = createRemoteClient({
    url: endpoint,
    token,
    outbound,
  });

  for (const line of lines) {
    let frame: { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      writer.diagnostic("REMOTE_INVALID_FRAME");
      continue;
    }
    if (typeof frame.method !== "string") {
      writer.diagnostic("REMOTE_INVALID_FRAME");
      continue;
    }
    const params =
      typeof frame.params === "object" && frame.params !== null && !Array.isArray(frame.params)
        ? (frame.params as Record<string, unknown>)
        : undefined;
    const { response } = await client.invoke(frame.method, params);
    const id = typeof frame.id === "number" ? frame.id : 0;
    writer.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        ...(response.error === undefined ? { result: response.result } : { error: response.error }),
      })}\n`
    );
  }
  await writer.flush();
  return 0;
}

export async function runRemoteMode(args: CliArgs, lines?: readonly string[]): Promise<number> {
  const writer = createStdoutWriter({
    write: (chunk) => process.stdout.write(chunk) !== false,
    diagnostic: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  try {
    return await executeRemoteFrames(args, writer, lines);
  } finally {
    await writer.close();
  }
}
