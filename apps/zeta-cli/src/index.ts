#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgent,
  createCommandRegistry,
  createOpenAiStreamFn,
  decorateModels,
  fetchModelIds,
  MODES,
  parseCommand,
  type Agent,
  type AgentStreamFn,
} from "@zeta-agent/agent";
import type {
  RuntimeMessage,
  RuntimeTuiHandle,
  SubmitMode,
  UsagePricing,
} from "@zeta-agent/tui";
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
  "模型与连接:",
  "  TUI 内按 /connect 现场输入 API Base URL 与 Key（仅内存，不落盘），",
  "  连接后自动从 {baseUrl}/models 拉取真实模型列表；模型的价格/上下文/多模态",
  "  等元数据来自内置 models.dev 目录（官方实验室去重数据）。无连接则不显示模型。",
  "  环境变量（headless 与 TUI 通用）: ZETA_BASE_URL / ZETA_API_KEY / ZETA_MODEL。",
  "  未配置连接时回退 echo（无网络）。密钥勿写入仓库。",
].join("\n");

/**
 * 连接后选择有效模型：保留仍存在于新列表的用户选择；
 * 未连接（echo）或旧模型不在新列表时采用首个模型；无可用模型返回 undefined。
 */
export function selectModelAfterConnect(
  currentModel: string,
  discoveredIds: readonly string[]
): string | undefined {
  const first = discoveredIds[0];
  if (currentModel !== "echo" && discoveredIds.includes(currentModel)) return currentModel;
  return first;
}

/** 连接代次序列：只有最新发起的连接结果才允许发布。 */
export function createConnectionSequence(): {
  next(): number;
  isCurrent(generation: number): boolean;
} {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
  };
}

function echoStream(): AgentStreamFn {
  return async function* (request) {
    const last = request.messages.at(-1);
    if (last?.role === "user") yield `[echo] ${String(last.content)}`;
  };
}

/** 把 models.dev 的 "$input/output"（每百万 token）定价串解析为遥测计价。 */
export function parseModelPrice(price: string | undefined): UsagePricing | undefined {
  if (price === "free") return { inputPerMillion: 0, outputPerMillion: 0 };
  if (price === undefined || price === "-") return undefined;
  const match = /^\$([\d.]+)\/([\d.]+)$/.exec(price);
  const input = match?.[1];
  const output = match?.[2];
  if (input === undefined || output === undefined) return undefined;
  return { inputPerMillion: Number(input), outputPerMillion: Number(output) };
}

interface Connection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface AgentBundle {
  readonly agent: Agent;
  readonly model: string;
  /** 已配置时才有模型；未配置 API/Key 时为空（不显示任何模型）。 */
  readonly models: readonly string[];
  readonly connection: Connection | undefined;
  readonly missing: readonly string[];
  readonly initialModel: string | undefined;
  setModel(model: string): void;
  /** 设置内存连接配置（不落盘）。 */
  connect(baseUrl: string, apiKey: string): void;
}

function makeAgent(): AgentBundle {
  const resolution = resolveModelConfig(process.env);
  let connection: Connection | undefined =
    resolution.kind === "configured"
      ? { baseUrl: resolution.config.baseUrl, apiKey: resolution.config.apiKey }
      : undefined;
  let modelName = resolution.kind === "configured" ? resolution.config.model : "echo";
  const streamFn: AgentStreamFn = (request) => {
    if (connection !== undefined) {
      return createOpenAiStreamFn({ ...connection, model: modelName })(request);
    }
    return echoStream()(request);
  };
  const agent = createAgent({
    streamFn,
    allowedDirectories: [process.cwd()],
  });
  return {
    agent,
    get model() {
      return modelName;
    },
    // 未配置 API/Key 时不显示任何模型。
    models: [],
    get connection() {
      return connection;
    },
    missing: resolution.kind === "fallback" ? resolution.missing : [],
    initialModel: resolution.kind === "configured" ? modelName : undefined,
    setModel(next: string) {
      modelName = next;
    },
    connect(baseUrl: string, apiKey: string) {
      connection = { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
      // 不在此处清空模型；模型选择由 selectModelAfterConnect 基于新列表统一决定。
    },
  };
}

function toRuntimeMessages(messages: readonly { role: string; content: unknown }[]): readonly RuntimeMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

export async function loadInteractiveTui() {
  await import("@opentui/solid/preload");
  return import("@zeta-agent/tui");
}

export function createSteerLock(): { tryAcquire(): boolean; release(): void } {
  let active = false;
  return {
    tryAcquire() {
      if (active) return false;
      active = true;
      return true;
    },
    release() {
      active = false;
    },
  };
}

export function createSteerRunner(deps: {
  isBusy(): boolean;
  prompt(text: string): Promise<unknown>;
  waitForIdle(): Promise<void>;
  onBusy(): void;
  onError(error: unknown): void;
  restoreDraft?(text: string): void;
}): { start(text: string): { accepted: boolean; done: Promise<void> } } {
  const lock = createSteerLock();
  return {
    start(text) {
      if (deps.isBusy() || !lock.tryAcquire()) {
        deps.onBusy();
        return { accepted: false, done: Promise.resolve() };
      }
      const done = deps.prompt(text)
        .then(() => deps.waitForIdle())
        .catch((error: unknown) => {
          deps.restoreDraft?.(text);
          deps.onError(error);
        })
        .finally(() => {
          lock.release();
        });
      return { accepted: true, done };
    },
  };
}

async function runTui(args: CliArgs): Promise<number> {
  const { detectGitBranch, renderTui } = await loadInteractiveTui();
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
    name: "connect",
    description: "设置 API Base URL 与 Key（仅内存）",
    category: "session",
    handler: () => {
      // 实际交互由 TUI 的 /connect 本地命令打开连接对话框处理。
      notice("请用 /connect 打开连接对话框，输入 Base URL 与 API Key");
    },
  });
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
  const connectionSeq = createConnectionSequence();

  /** 设置内存连接并拉取 /v1/models；仅最新代次可发布，失败也不覆盖更新的连接。 */
  const applyConnection = async (baseUrl: string, apiKey: string): Promise<void> => {
    const generation = connectionSeq.next();
    notice(`连接 ${baseUrl}：正在拉取模型列表…`);
    try {
      const ids = await fetchModelIds({ baseUrl, apiKey });
      if (!connectionSeq.isCurrent(generation)) return; // 迟到结果，忽略
      const previousModel = bundle.model;
      const chosen = selectModelAfterConnect(previousModel, ids);
      if (chosen === undefined) {
        throw new Error("MODELS_EMPTY: 无可发送的模型");
      }
      bundle.connect(baseUrl, apiKey);
      bundle.setModel(chosen);
      const options = decorateModels(ids);
      tui?.setModelOptions(options);
      tui?.setModel(chosen);
      notice(`已连接：${ids.length} 个模型（当前 ${chosen}，/model 可切换）`);
    } catch (error) {
      if (!connectionSeq.isCurrent(generation)) return; // 过期的失败也不提示
      notice(`连接失败：${(error as Error).message}；请用 /connect 重新设置 API 与 Key`);
    }
  };

  // 若启动时已配置环境变量，尝试拉取真实模型列表。
  if (bundle.connection !== undefined) {
    void applyConnection(bundle.connection.baseUrl, bundle.connection.apiKey);
  }

  const startSteer = createSteerRunner({
    isBusy: () => agent.state.isStreaming || agent.state.pendingToolCalls.size > 0,
    prompt: (text) => agent.prompt(text),
    waitForIdle: () => agent.waitForIdle(),
    onBusy: () => notice("正在运行中：请等待完成，或按 Esc 中止后再发送"),
    onError: (error) => notice(`发送失败：${(error as Error).message}`),
    restoreDraft: (text) => tui?.restoreDraft?.(text),
  }).start;

  const handleCommand = async (text: string, mode: SubmitMode = "steer"): Promise<boolean> => {
    if (!text.startsWith("/")) {
      if (mode === "follow-up") {
        agent.followUp({ role: "user", content: text });
        notice(`已排队 follow-up：${text}`);
        return true;
      }
      return startSteer(text).accepted;
    }
    const result = await registry.execute(text);
    if (!result.ok) {
      const parsed = parseCommand(text);
      notice(`未知命令：/${parsed?.name ?? text}（/help 查看可用命令）`);
      return false;
    }
    if (!hostCommands.has(result.name)) {
      notice(`/${result.name} 暂未接入（当前可用：/help /clear /new /model /theme /settings /session /compact /export /quit）`);
    }
    return true;
  };

  tui = await renderTui({
    ...buildTuiOptions(agent, VERSION, handleCommand, {
      cwd: process.cwd(),
      model: bundle.model,
      models: bundle.models,
      onModelChange: (model) => bundle.setModel(model),
      onConnect: (url, key) => {
        void applyConnection(url, key);
      },
      connection: {
        url: bundle.connection?.baseUrl,
        // 不把真实 key 传给对话框做回显（仅 URL 兜底）。
      },
      reasoningEffort: agent.reasoningEffort,
      onEffortChange: (effort) => {
        agent.setReasoningEffort(effort);
        notice(`思考强度: ${effort}`);
      },
      commandCatalog: registry.list().map((command) => ({
        name: command.name,
        description: command.description,
      })),
      onCommand: handleCommand,
      onSubmitError: (error) => notice(`发送失败：${(error as Error).message}`),
      onAbort: () => agent.abort(),
      // /new：清空真实会话上下文，使下一轮请求不再携带旧消息。
      onNewSession: () => agent.reset(),
      resources: { models: bundle.models.slice(0, 4) },
      telemetry: {
        cwd: process.cwd(),
        branch: detectGitBranch(process.cwd()),
        session: `zeta-${process.pid}`,
        pricing: parseModelPrice(decorateModels([bundle.model])[0]?.price),
      },
    }),
    messages: toRuntimeMessages(agent.state.messages),
  });

  if (bundle.missing.length > 0) {
    notice(`模型配置缺失：${bundle.missing.join(", ")}；当前使用 echo`);
  }

  try {
    if (args.prompt !== undefined) {
      const initial = startSteer(args.prompt);
      if (initial.accepted) await initial.done;
    }
    await tui.waitForExit();
  } finally {
    await tui.destroy();
  }
  return 0;
}

/**
 * RPC 帧来源：非 TTY 时优先读 stdin 的逐行帧；否则沿用 argv 的单帧。
 * 每行一条 JSON-RPC 帧，空行忽略。
 */
export function collectRpcLines(argvPrompt: string | undefined, stdinText: string, isTTY: boolean): string[] {
  if (!isTTY && stdinText.trim().length > 0) {
    return stdinText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }
  return argvPrompt !== undefined ? [argvPrompt] : [];
}

async function readStdinFrames(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runHeadless(args: CliArgs): Promise<number> {
  const { agent, missing } = makeAgent();
  if (missing.length > 0) {
    process.stderr.write(`zeta: 模型配置缺失：${missing.join(", ")}；使用 echo\n`);
  }
  const mode = args.mode === "json" ? "json" : args.mode === "rpc" ? "rpc" : "print";
  const stdinText = mode === "rpc" && !process.stdin.isTTY ? await readStdinFrames() : "";
  const opts = {
    prompt: args.prompt,
    lines: mode === "rpc"
      ? collectRpcLines(args.prompt, stdinText, process.stdin.isTTY === true)
      : args.prompt !== undefined ? [args.prompt] : [],
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
