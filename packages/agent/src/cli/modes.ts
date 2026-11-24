import type { Agent, AgentMessage } from "../facade";
import { encodeControlFrame, type RuntimeProtocol } from "../assembly/protocol";

export type ModeName = "interactive" | "print" | "json" | "rpc";

export const MODE_NAMES: readonly ModeName[] = Object.freeze([
  "interactive",
  "print",
  "json",
  "rpc",
]);

export interface ModeOptions {
  readonly prompt?: string;
  readonly lines?: readonly string[];
  readonly output?: (line: string) => void;
  readonly tty?: boolean;
  /** 统一 session/control/event 协议；四种模式都经它访问运行时。 */
  readonly protocol?: RuntimeProtocol;
}

export interface ModePlugin {
  readonly name: ModeName;
  readonly requiresTTY: boolean;
  run(agent: Agent, opts?: ModeOptions): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export function encodeRpcFrame(frame: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...frame });
}

export function encodeRpcRequest(request: {
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}): string {
  return encodeRpcFrame(request);
}

export function decodeRpcFrame(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("RPC_INVALID_FRAME");
  return parsed;
}

/** 检测 facade 在回合失败时编码进 assistant 消息的 Error 文本。 */
export function detectRunError(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("Error:")
  );
}

async function runTranscript(
  agent: Agent,
  opts: ModeOptions,
  format: "print" | "json"
): Promise<number> {
  const output = opts.output ?? (() => {});
  const dispose = agent.subscribe((event) => {
    if (format === "json") {
      output(JSON.stringify(event));
      return;
    }
    if (event.type === "message_end") {
      output(`${event.message.role}: ${String(event.message.content)}`);
    }
    if (event.type === "tool_execution_end") {
      output(`tool ${event.toolName}: ${event.isError ? "error" : "ok"}`);
    }
  });
  let messages: readonly AgentMessage[];
  try {
    const text = opts.prompt ?? opts.lines?.[0] ?? "";
    if (opts.protocol !== undefined) {
      const result = await opts.protocol.control.dispatch(encodeControlFrame({ action: "prompt", text }));
      messages = result.messages ?? agent.state.messages;
    } else {
      messages = await agent.prompt(text);
      await agent.waitForIdle();
    }
  } finally {
    dispose();
  }
  return detectRunError(messages) ? 1 : 0;
}

async function runInteractive(agent: Agent, opts: ModeOptions): Promise<number> {
  const output = opts.output ?? (() => {});
  const prompts =
    opts.lines !== undefined && opts.lines.length > 0
      ? opts.lines
      : opts.prompt !== undefined
        ? [opts.prompt]
        : [];
  for (const text of prompts) {
    output(`> ${text}`);
    let messages: readonly AgentMessage[];
    if (opts.protocol !== undefined) {
      const result = await opts.protocol.control.dispatch(encodeControlFrame({ action: "prompt", text }));
      messages = result.messages ?? agent.state.messages;
    } else {
      messages = await agent.prompt(text);
      await agent.waitForIdle();
    }
    for (const message of messages) {
      if (message.role === "assistant") output(String(message.content));
    }
  }
  return 0;
}

async function runRpc(agent: Agent, opts: ModeOptions): Promise<number> {
  const output = opts.output ?? (() => {});
  for (const line of opts.lines ?? []) {
    const frame = decodeRpcFrame(line);
    if (
      frame.jsonrpc !== "2.0" ||
      typeof frame.id !== "number" ||
      typeof frame.method !== "string"
    ) {
      throw new Error("RPC_INVALID_REQUEST");
    }
    const id = frame.id;
    const method = frame.method;
    if (method === "prompt" || method === "continue") {
      const params = isRecord(frame.params) ? frame.params : undefined;
      let messages: readonly AgentMessage[];
      if (opts.protocol !== undefined) {
        const text = method === "prompt" ? params?.text : undefined;
        if (method === "prompt" && typeof text !== "string") throw new Error("RPC_INVALID_PARAMS");
        const result = await opts.protocol.dispatch(
          method === "prompt"
            ? encodeControlFrame({ action: "prompt", text: text as string })
            : encodeControlFrame({ action: "continue" })
        );
        if (!result.ok) {
          output(encodeRpcFrame({ id, error: { code: -32000, message: result.error ?? "RUN_FAILED" } }));
          continue;
        }
        messages = result.messages ?? agent.state.messages;
      } else {
        if (method === "prompt") {
          const text = params?.text;
          if (typeof text !== "string") throw new Error("RPC_INVALID_PARAMS");
          messages = await agent.prompt(text);
        } else {
          messages = await agent.continue();
        }
        await agent.waitForIdle();
      }
      if (detectRunError(messages)) {
        output(encodeRpcFrame({ id, error: { code: -32000, message: "RUN_FAILED" } }));
        continue;
      }
      output(
        encodeRpcFrame({
          id,
          result: {
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          },
        })
      );
      continue;
    }
    output(encodeRpcFrame({ id, error: { code: -32601, message: "METHOD_NOT_FOUND" } }));
  }
  return 0;
}

export const MODES: Record<ModeName, ModePlugin> = {
  interactive: {
    name: "interactive",
    requiresTTY: true,
    run: (agent, opts = {}) => runInteractive(agent, opts),
  },
  print: {
    name: "print",
    requiresTTY: false,
    run: (agent, opts = {}) => runTranscript(agent, opts, "print"),
  },
  json: {
    name: "json",
    requiresTTY: false,
    run: (agent, opts = {}) => runTranscript(agent, opts, "json"),
  },
  rpc: {
    name: "rpc",
    requiresTTY: false,
    run: (agent, opts = {}) => runRpc(agent, opts),
  },
};

export function modeNames(): ModeName[] {
  return [...MODE_NAMES];
}

export function selectMode(name: string): ModePlugin {
  if (!Object.prototype.hasOwnProperty.call(MODES, name)) {
    throw new Error(`UNKNOWN_MODE: ${name}`);
  }
  return MODES[name as ModeName] as ModePlugin;
}

export interface CliFacade {
  selectMode(name: string): ModePlugin;
  run(name: string, agent: Agent, opts?: ModeOptions): Promise<number>;
}

export function createCliFacade(): CliFacade {
  return {
    selectMode,
    run(name, agent, opts = {}) {
      return selectMode(name).run(agent, opts);
    },
  };
}
