import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";
import { loadModePlugin, promptFromStdin } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const entry = resolve(here, "index.ts");

function run(args: readonly string[], input = "") {
  const env = { ...process.env };
  delete env.ZETA_BASE_URL;
  delete env.ZETA_API_KEY;
  delete env.ZETA_MODEL;
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 25_000,
  });
}

describe("T-23 单一 ModePlugin loader 与 TTY 守卫", () => {
  test("七种 CLI 形态只在 loader 映射一次，交互式需要 TTY", () => {
    expect(loadModePlugin(parseArgs([]), false)).toBeUndefined();
    expect(loadModePlugin(parseArgs([]), true)?.name).toBe("interactive");
    expect(loadModePlugin(parseArgs(["--headless", "x"]), false)?.name).toBe("print");
    expect(loadModePlugin(parseArgs(["--json", "x"]), false)?.name).toBe("json");
    expect(loadModePlugin(parseArgs(["--rpc"]), false)?.name).toBe("rpc");
    expect(loadModePlugin(parseArgs(["--daemon"]), true)).toBeUndefined();
    expect(loadModePlugin(parseArgs(["--remote"]), true)).toBeUndefined();
  });

  test("非 TTY 交互模式守卫返回 early exit，不加载 TUI", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("非 TTY");
    expect(result.stderr).not.toContain("OPENTUI");
  });

  test("管道输入修剪后有提示词，空管道不伪造输入", () => {
    expect(promptFromStdin("  hello pipe \n")).toBe("hello pipe");
    expect(promptFromStdin("\n\n")).toBeUndefined();
  });
});

describe("T-23 headless stdin / 非零退出码 / stdout 纯净", () => {
  test("print 读取管道 stdin", () => {
    const result = run(["--headless"], "hello via stdin\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("user: hello via stdin");
    expect(result.stdout).toContain("[echo] hello via stdin");
  });

  test("json 读取管道 stdin，每行可解析", () => {
    const result = run(["--json"], "json via stdin\n");
    expect(result.status).toBe(0);
    const frames = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(frames.some((frame) => frame.type === "message_end")).toBe(true);
  });

  test("非法 RPC 帧非零退出且 stdout 不承载诊断", () => {
    const result = run(["--rpc"], "not-a-json-frame\n");
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("RPC 帧解析失败");
  });
});

describe("T-23 CLI RPC 使用完整 dispatcher", () => {
  test("readiness/configDigest/health 与未知方法都由 dispatcher 投影", () => {
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "readiness" },
      { jsonrpc: "2.0", id: 2, method: "configDigest" },
      { jsonrpc: "2.0", id: 3, method: "health" },
      { jsonrpc: "2.0", id: 4, method: "totally.unknown" },
    ];
    const result = run(["--rpc"], frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
    expect(result.status).toBe(0);
    const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({ id: 1, result: true });
    expect(typeof responses[1]?.result).toBe("string");
    expect(responses[2]?.result).toMatchObject({ ready: true, live: true });
    expect(responses[3]).toMatchObject({
      id: 4,
      error: { code: -32601, message: "METHOD_NOT_FOUND" },
    });
  });

  test("prompt 帧走真实 control 协议并返回真实消息", () => {
    const request = { jsonrpc: "2.0", id: 7, method: "prompt", params: { text: "rpc via stdin" } };
    const result = run(["--rpc"], JSON.stringify(request) + "\n");
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    expect(response.id).toBe(7);
    expect(response.result.messages.some((message: { content: unknown }) =>
      String(message.content).includes("rpc via stdin"))).toBe(true);
  });
});
