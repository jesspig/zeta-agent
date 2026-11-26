#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCommandRegistry,
  createDefaultRuntime,
  createOpenAiStreamFn,
  decorateModels,
  fetchModelIds,
  MODES,
  parseCommand,
  selectMode,
  type Agent,
  type AgentStreamFn,
  type DefaultRuntime,
  type ModeName,
  type ModePlugin,
} from "@zeta-agent/agent";
import {
  assertStartupArtifact,
  createRpcDispatcher,
  createStdoutWriter,
  decodeRpcRequest,
  encodeRpcResponse,
  hostTarget,
  isCompiledExecutable,
  type DeployHandle,
  type RpcDispatcher,
} from "@zeta-agent/deploy";
import type {
  RuntimeMessage,
  RuntimeTuiHandle,
  SubmitMode,
  UsagePricing,
} from "@zeta-agent/tui";
import { parseArgs, type CliArgs } from "./args";
import { createConnectionOutbound } from "./connection";
import { resolveModelConfig } from "./config";
import { runDaemonMode } from "./daemon";
import { runRemoteMode } from "./remote";
import { createDeferredTelemetry, withFirstFrame } from "./deferred-telemetry";
import { EMBEDDED_ASSETS, EMBEDDED_MANIFEST } from "./embedded-assets.generated";
import { embeddedResources } from "./embedded-resources";
import { createProbeHandle, handleProbeFrame } from "./probes";
import { createCliRpcRuntime } from "./daemon";
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
  "  zeta --rpc <帧>            headless RPC 帧（探针帧：{\"type\":\"probe\",\"probe\":\"readiness\"}）",
  "  zeta --daemon --token <t>   启动控制面 daemon（HTTP + IPC + 自动重启）",
  "  zeta --remote --endpoint <url> --token <t> <帧>  经远程 SDK 调用控制面",
  "  zeta --watch <目录>        监视插件目录，文件变更不重启生效（可重复）",
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
    // 生产 provider 必须给出显式终态；无 terminal 的 EOF 会被 broker 归一化为 incomplete_stream。
    yield { type: "done", stopReason: "stop" };
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
  readonly runtime: DefaultRuntime;
  readonly sessionStore: DefaultRuntime["sessionStore"];
  readonly workspaceStore: DefaultRuntime["workspaceStore"];
  readonly agent: Agent;
  readonly probes: DeployHandle;
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

/** 统一 loader：config → 默认装配（含 root fiber）→ 返回共享运行时句柄。 */
export async function makeRuntime(args: CliArgs): Promise<AgentBundle> {
  const resolution = resolveModelConfig(process.env);
  let connection: Connection | undefined =
    resolution.kind === "configured"
      ? { baseUrl: resolution.config.baseUrl, apiKey: resolution.config.apiKey }
      : undefined;
  let modelName = resolution.kind === "configured" ? resolution.config.model : "echo";
  let outbound = connection === undefined ? undefined : createConnectionOutbound(connection.baseUrl);
  const streamFn: AgentStreamFn = (request) => {
    if (connection !== undefined && outbound !== undefined) {
      return createOpenAiStreamFn({ ...connection, model: modelName }, outbound.fetch)(request);
    }
    return echoStream()(request);
  };
  // daemon/rpc 是跨进程控制面：会话与 workspace 必须落在真实持久存储，不用内存 stub。
  const persistentControl = args.mode === "daemon" || args.mode === "rpc" ||
    typeof process.env.ZETA_SESSION_PATH === "string";
  const sessionStorePath = process.env.ZETA_SESSION_PATH ??
    (persistentControl ? join(resolveDataDir(), "session.jsonl") : undefined);
  const workspaceStorePath = process.env.ZETA_WORKSPACE_PATH ??
    (persistentControl ? join(resolveDataDir(), "workspace") : undefined);
  const runtime = await createDefaultRuntime({
    streamFn,
    allowedDirectories: [process.cwd()],
    profile: args.profile,
    embeddedResources: embeddedResources(),
    hotReloadDirs: args.watchDirs,
    ...(sessionStorePath === undefined ? {} : { sessionStorePath }),
    ...(workspaceStorePath === undefined ? {} : { workspaceStorePath }),
    ...(sessionStorePath === undefined ? {} : {
      compactionBudget: { totalContextLimit: 128_000, compactionThreshold: 96_000 },
      compactionMaxOutputBytes: 64 * 1024,
    }),
  });
  const probes = createProbeHandle(runtime, { target: hostTarget() ?? "linux-x64", profile: args.profile });
  return {
    runtime,
    sessionStore: runtime.sessionStore,
    workspaceStore: runtime.workspaceStore,
    agent: runtime.agent,
    probes,
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
      outbound = createConnectionOutbound(connection.baseUrl);
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

export interface CliModeSelection {
  readonly name: ModeName;
  readonly plugin: ModePlugin;
}

/**
 * 单一 ModePlugin loader：CLI 形态只在这里映射到 agent 的四种模式插件。
 * 交互式插件 requiresTTY；守卫在 loadInteractiveTui() 之前完成，
 * 因此 headless/print/json/rpc 永远走不到 OpenTUI import。
 */
export function loadModePlugin(
  args: CliArgs,
  tty: boolean = process.stdin.isTTY === true,
): CliModeSelection | undefined {
  if (args.mode === "daemon" || args.mode === "remote") return undefined;
  const name: ModeName =
    args.mode === "tui" ? "interactive"
      : args.mode === "headless" ? "print"
        : args.mode === "json" ? "json"
          : "rpc";
  const plugin = selectMode(name);
  if (plugin.requiresTTY && !tty) return undefined;
  return { name, plugin };
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

async function runTui(args: CliArgs, bundle: AgentBundle): Promise<number> {
  // TTY 守卫必须先于任何 TUI/OpenTUI import：非 TTY 时绝不加载原生渲染栈。
  if (process.stdin.isTTY !== true) {
    process.stdout.write("(非 TTY：请用 zeta --headless \"提示词\"；交互式 TUI 需要 TTY)\n");
    return 0;
  }
  const { detectGitBranch, renderTui } = await loadInteractiveTui();
  const agent = bundle.agent;

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
      const ids = await fetchModelIds({
        baseUrl,
        apiKey,
        outbound: createConnectionOutbound(baseUrl),
      });
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

  const telemetry = createDeferredTelemetry(async () => {
    const module = await import("./telemetry-heavy");
    await module.activateTelemetry();
  });

  tui = await withFirstFrame({
    render: () =>
      renderTui({
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
      }),
    afterFirstFrame: () => telemetry.start(),
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

export async function readStdinFrames(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** 管道输入修剪为单条提示词；空管道不产生提示词，不伪造用户输入。 */
export function promptFromStdin(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** CLI RPC 唯一生产路径：全量 method / 错误码 / 会话能力均来自 deploy 的 dispatcher。 */
async function runCliRpc(
  bundle: AgentBundle,
  lines: readonly string[],
  writer: ReturnType<typeof createStdoutWriter>,
): Promise<number> {
  let dispatcher: RpcDispatcher;
  try {
    dispatcher = createRpcDispatcher(createCliRpcRuntime(bundle));
  } catch (error) {
    writer.diagnostic(`zeta: RPC 控制面不可用：${(error as Error).message}`);
    return 1;
  }
  let failed = false;
  for (const line of lines) {
    let request;
    try {
      request = decodeRpcRequest(line);
    } catch (error) {
      // 非法帧只写 stderr，stdout 保持纯净（协议通道只承载合法响应）。
      writer.diagnostic(`zeta: RPC 帧解析失败：${(error as Error).message}`);
      failed = true;
      continue;
    }
    try {
      const response = await dispatcher.handle(request);
      writer.write(encodeRpcResponse(response) + "\n");
    } catch (error) {
      writer.diagnostic(`zeta: RPC 处理失败：${(error as Error).message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

async function runHeadless(
  args: CliArgs,
  bundle: AgentBundle,
  selection: CliModeSelection,
): Promise<number> {
  const { agent, missing } = bundle;
  const writer = createStdoutWriter({
    write: (chunk) => process.stdout.write(chunk) !== false,
    diagnostic: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  if (missing.length > 0) {
    writer.diagnostic(`zeta: 模型配置缺失：${missing.join(", ")}；使用 echo`);
  }
  const mode = selection.name;
  // print/json/rpc 都可从管道取输入；TTY 下绝不读取 stdin（会阻塞交互）。
  const stdinText = args.prompt === undefined && process.stdin.isTTY !== true
    ? await readStdinFrames()
    : "";
  const pipedPrompt = promptFromStdin(stdinText);
  const inputs = mode === "rpc"
    ? collectRpcLines(args.prompt, stdinText, process.stdin.isTTY === true)
    : [args.prompt ?? pipedPrompt ?? ""];
  const controlLines: string[] = [];
  for (const line of inputs) {
    const probe = handleProbeFrame(bundle.probes, line);
    if (probe !== undefined) {
      writer.write(probe + "\n");
    } else {
      controlLines.push(line);
    }
  }
  try {
    if (mode === "rpc") return await runCliRpc(bundle, controlLines, writer);
    const opts = {
      prompt: controlLines[0] ?? "",
      protocol: bundle.runtime.protocol,
      lines: controlLines,
      output: (line: string) => writer.write(line + "\n"),
    };
    return await MODES[mode].run(agent, opts);
  } catch (error) {
    writer.diagnostic(`zeta: ${(error as Error).message}`);
    return 1;
  } finally {
    await writer.flush();
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

  try {
    assertStartupArtifact(EMBEDDED_MANIFEST, EMBEDDED_ASSETS);
  } catch (error) {
    process.stderr.write(`zeta: 启动产物校验失败：${(error as Error).message}\n`);
    return 3;
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

  // 统一流水线：parse（上）→ config → loader → root fiber → mode。
  // 能力诊断只走到 loader 为止，不加载 TUI、不发模型请求。
  const bundle = await makeRuntime(args);
  try {
    if (args.capabilities) {
      const manifest = bundle.runtime.manifest;
      process.stdout.write(
        JSON.stringify({
          profile: manifest.profile,
          plugins: manifest.plugins,
          tools: manifest.tools,
          services: manifest.services,
          session: manifest.session,
          modes: manifest.modes,
          resources: manifest.resources,
          diagnostics: manifest.diagnostics,
          sessionState: {
            id: bundle.runtime.protocol.session.id,
            messageCount: bundle.runtime.protocol.session.messages().length,
            persisted: bundle.sessionStore !== undefined,
          },
        }) + "\n"
      );
      return 0;
    }
    // 单一 loader 在（且只在）这里解析模式；交互式 TTY 守卫早于任何 TUI import。
    const selection = loadModePlugin(args);
    if (args.mode === "tui" && selection === undefined) {
      process.stdout.write("(非 TTY：请用 zeta --headless \"提示词\"；交互式 TUI 需要 TTY)\n");
      return 0;
    }
    if (args.mode === "daemon") return runDaemonMode(args, bundle);
    if (args.mode === "remote") {
      const stdinText = args.prompt === undefined && process.stdin.isTTY === false ? await readStdinFrames() : "";
      return runRemoteMode(
        args,
        collectRpcLines(args.prompt, stdinText, process.stdin.isTTY === true)
      );
    }
    if (selection === undefined) throw new Error(`UNSUPPORTED_MODE: ${args.mode}`);
    return selection.name === "interactive"
      ? await runTui(args, bundle)
      : await runHeadless(args, bundle, selection);
  } finally {
    await bundle.runtime.dispose();
    bundle.probes.stop();
  }
}

// Bun compile 的单文件产物里 import.meta.main 为 false，需用可执行文件路径判定。
if (import.meta.main || isCompiledExecutable()) {
  const code = await main();
  process.exit(code);
}
