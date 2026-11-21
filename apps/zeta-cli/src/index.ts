#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { createAgent, createOpenAiStreamFn, MODES, type Agent, type AgentStreamFn } from "@zeta-agent/agent";
import { renderTui, type RuntimeMessage } from "@zeta-agent/tui";
import { parseArgs, type CliArgs } from "./args";
import { resolveModelConfig } from "./config";
import { resolveDataDir } from "./runtime";
import { buildTuiOptions } from "./tui-options";

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

function toRuntimeMessages(messages: readonly { role: string; content: unknown }[]): readonly RuntimeMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

async function runTui(args: CliArgs): Promise<number> {
  const agent = makeAgent();

  if (!process.stdin.isTTY) {
    process.stdout.write("(非 TTY：请用 zeta --headless \"提示词\"；交互式 TUI 需要 TTY)\n");
    return 0;
  }

  const tui = await renderTui({
    ...buildTuiOptions(agent, VERSION, async (text) => {
      await agent.prompt(text);
      await agent.waitForIdle();
    }),
    messages: toRuntimeMessages(agent.state.messages),
  });

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      tui.appendMessage({ role: event.message.role, content: event.message.content });
    }
  });

  try {
    if (args.prompt !== undefined) {
      await agent.prompt(args.prompt);
      await agent.waitForIdle();
    }
    await tui.waitForExit();
  } finally {
    unsubscribe();
    await tui.destroy();
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
