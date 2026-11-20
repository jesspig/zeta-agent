#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { createAgent, createOpenAiStreamFn, MODES, type Agent, type AgentStreamFn } from "@zeta-agent/agent";
import { testRender, type FrameState } from "@zeta-agent/tui";
import { parseArgs, type CliArgs } from "./args";
import { resolveModelConfig } from "./config";
import { resolveDataDir } from "./runtime";

const VERSION = "0.1.0";
const HELP = [
  "zeta — 万物皆插件 Agent Harness",
  "",
  "用法:",
  "  zeta                      启动 TUI（默认）",
  "  zeta \"提示词\"              TUI 内直接提交一条提示词",
  "  zeta --headless \"提示词\"   headless 打印模式（无需 TTY）",
  "  zeta --json \"提示词\"       headless JSON 事件流",
  "  zeta --rpc <帧>            headless RPC 帧",
  "  zeta --help                显示帮助",
  "  zeta --version             显示版本",
  "",
  "数据目录: ~/.zeta-agent/（当前仅内存态，持久化后续接入）",
  "",
  "模型配置（环境变量，headless 与 TUI 通用）:",
  "  ZETA_BASE_URL   OpenAI 兼容 API 基址，如 https://host/v1",
  "  ZETA_API_KEY    Bearer 令牌",
  "  ZETA_MODEL      模型名，如 provider/model",
  "  三项齐全时用真实模型；否则回退 echo（无网络）。密钥勿写入仓库。",
].join("\n");

function echoStream(): AgentStreamFn {
  return async function* (request) {
    const last = request.messages.at(-1);
    if (last?.role === "user") yield `[echo] ${String(last.content)}`;
  };
}

function makeAgent(): Agent {
  const config = resolveModelConfig(process.env);
  const streamFn: AgentStreamFn = config !== null ? createOpenAiStreamFn(config) : echoStream();
  return createAgent({ streamFn });
}

function renderMessages(messages: readonly { role: string; content: unknown }[]): string {
  const lines = messages.map((message) => `${message.role}: ${String(message.content)}`);
  const hud = `zeta v${VERSION}  |  数据: ~/.zeta-agent/ (内存)`;
  const state: FrameState = { width: 72, height: Math.max(6, lines.length + 4), lines, hud };
  return testRender(state);
}

async function draw(agent: Agent, clear: boolean): Promise<void> {
  if (clear && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(renderMessages(agent.state.messages) + "\n");
}

async function runTui(args: CliArgs): Promise<number> {
  const agent = makeAgent();
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") void draw(agent, true);
  });

  try {
    if (args.prompt !== undefined) {
      await agent.prompt(args.prompt);
      await agent.waitForIdle();
      await draw(agent, true);
      return 0;
    }

    if (!process.stdin.isTTY) {
      await draw(agent, false);
      process.stdout.write("(非 TTY：请用 zeta --headless \"提示词\" 或 zeta \"提示词\")\n");
      return 0;
    }

    await draw(agent, true);
    process.stdout.write("zeta TUI（输入 exit 退出）\n");
    for await (const line of console) {
      const text = line.trim();
      if (text === "exit" || text === "quit") break;
      if (text.length === 0) continue;
      await agent.prompt(text);
      await agent.waitForIdle();
      await draw(agent, true);
    }
  } finally {
    unsubscribe();
  }
  return 0;
}

async function runHeadless(args: CliArgs): Promise<number> {
  const agent = makeAgent();
  const mode = args.mode === "json" ? "json" : args.mode === "rpc" ? "rpc" : "print";
  const opts = {
    prompt: args.prompt,
    lines: args.prompt !== undefined ? [args.prompt] : [],
    output: (line: string) => process.stdout.write(line + "\n"),
  };
  try {
    return await MODES[mode].run(agent, opts);
  } catch (error) {
    process.stderr.write(`zeta: ${(error as Error).message}\n`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.version) {
    process.stdout.write(`zeta ${VERSION}\n`);
    return 0;
  }

  mkdirSync(resolveDataDir(), { recursive: true });
  return args.mode === "tui" ? runTui(args) : runHeadless(args);
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
