#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgent,
  createCommandRegistry,
  createModelRegistry,
  createOpenAiStreamFn,
  MODES,
  parseCommand,
  type Agent,
  type AgentStreamFn,
} from "@zeta-agent/agent";
import { renderTui, type RuntimeMessage, type RuntimeTuiHandle } from "@zeta-agent/tui";
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

interface AgentBundle {
  readonly agent: Agent;
  readonly model: string;
  readonly models: readonly string[];
  setModel(model: string): void;
}

function makeAgent(): AgentBundle {
  const resolution = resolveModelConfig(process.env);
  let modelName = resolution.kind === "configured" ? resolution.config.model : "echo";
  let streamFn: AgentStreamFn;
  if (resolution.kind === "configured") {
    const config = resolution.config;
    // 每次请求按当前模型构造，使 /model 切换能立即生效。
    streamFn = (request) => createOpenAiStreamFn({ ...config, model: modelName })(request);
  } else {
    process.stderr.write(
      `zeta: 模型配置缺失 ${resolution.missing.join(", ")}，回退 echo（无网络）。设置这三项以连接真实模型。\n`,
    );
    streamFn = echoStream();
  }
  const agent = createAgent({
    streamFn,
    // 文件工具只在工作目录内可用；否则内置 read/write/edit 会一律拒绝。
    allowedDirectories: [process.cwd()],
  });
  const catalog = createModelRegistry().list().map((model) => model.id);
  const models = resolution.kind === "configured"
    ? [...new Set([modelName, ...catalog])].slice(0, 24)
    : ["echo"];
  return {
    agent,
    get model() {
      return modelName;
    },
    models,
    setModel(next: string) {
      modelName = next;
    },
  };
}

function toRuntimeMessages(messages: readonly { role: string; content: unknown }[]): readonly RuntimeMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

async function runTui(args: CliArgs): Promise<number> {
  const bundle = makeAgent();
  const agent = bundle.agent;

  if (!process.stdin.isTTY) {
    process.stdout.write("(非 TTY：请用 zeta --headless \"提示词\"；交互式 TUI 需要 TTY)\n");
    return 0;
  }

  const registry = createCommandRegistry();
  let tui: RuntimeTuiHandle | undefined;

  const notice = (text: string): void => {
    tui?.appendMessage({ role: "notice", content: text });
  };

  registry.register({
    name: "session",
    description: "查看会话信息",
    category: "session",
    handler: () => {
      notice(`session: ${agent.state.messages.length} messages · model ${bundle.model}`);
    },
  });
  registry.register({
    name: "compact",
    description: "压缩会话上下文",
    category: "session",
    handler: () => {
      notice("compact: 当前为内存态会话，上下文压缩暂未接入");
    },
  });
  registry.register({
    name: "export",
    description: "导出会话为 JSONL",
    category: "export",
    handler: () => {
      const dir = join(resolveDataDir(), "exports");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `session-${Date.now()}.jsonl`);
      writeFileSync(path, agent.state.messages.map((message) => JSON.stringify(message)).join("\n"), "utf8");
      notice(`export: ${path}`);
    },
  });

  const hostCommands = new Set(["session", "compact", "export"]);

  const handleCommand = async (text: string): Promise<void> => {
    if (!text.startsWith("/")) {
      if (agent.state.isStreaming || agent.state.pendingToolCalls.size > 0) {
        notice("正在运行中：请等待完成，或按 Esc 中止后再发送");
        return;
      }
      await agent.prompt(text);
      await agent.waitForIdle();
      return;
    }
    const result = await registry.execute(text);
    if (!result.ok) {
      const parsed = parseCommand(text);
      notice(`未知命令：/${parsed?.name ?? text}（/help 查看可用命令）`);
      return;
    }
    if (!hostCommands.has(result.name)) {
      notice(`/${result.name} 暂未接入（当前可用：/help /clear /new /model /theme /settings /session /compact /export /quit）`);
    }
  };

  tui = await renderTui({
    ...buildTuiOptions(agent, VERSION, handleCommand, {
      cwd: process.cwd(),
      model: bundle.model,
      models: bundle.models,
      onModelChange: (model) => bundle.setModel(model),
      commandCatalog: registry.list().map((command) => ({
        name: command.name,
        description: command.description,
      })),
      onCommand: handleCommand,
      onAbort: () => agent.abort(),
      resources: { models: bundle.models.slice(0, 4) },
    }),
    messages: toRuntimeMessages(agent.state.messages),
  });

  try {
    if (args.prompt !== undefined) {
      await agent.prompt(args.prompt);
      await agent.waitForIdle();
    }
    await tui.waitForExit();
  } finally {
    await tui.destroy();
  }
  return 0;
}

async function runHeadless(args: CliArgs): Promise<number> {
  const { agent } = makeAgent();
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
