import type { Disposer } from "@zeta-agent/framework";
import {
  createEventStream,
  type AgentEvent,
  type AgentListener,
  type AgentMessage,
  type AgentState,
} from "@zeta-agent/agent-framework";

export type {
  AgentEvent,
  AgentListener,
  AgentMessage,
  AgentState,
} from "@zeta-agent/agent-framework";

export interface PluginTool<P = never> {
  readonly name: string;
  readonly execute: (input: P) => unknown;
}

export type PluginContribution =
  | { readonly kind: "tool"; readonly tool: PluginTool }
  | { readonly kind: "hook"; readonly event: string; readonly handler: (event: AgentEvent) => void }
  | { readonly kind: "section"; readonly text: string }
  | { readonly kind: "wrap"; readonly name: string }
  | { readonly kind: "task"; readonly name: string }
  | { readonly kind: "service"; readonly name: string };

export interface AgentPlugin {
  readonly kind: "AgentPlugin";
  readonly name: string;
  readonly contributions: readonly PluginContribution[];
  install(): Disposer;
}

export interface PiExtensionApi {
  registerTool<P>(tool: PluginTool<P>): void;
  on(event: string, handler: (event: AgentEvent) => void): void;
  addSection(text: string): void;
}

export interface DurableExtensionSpec {
  readonly tools?: readonly PluginTool[];
  readonly hooks?: readonly { readonly event: string; readonly handler: (event: AgentEvent) => void }[];
  readonly sections?: readonly string[];
  readonly wraps?: readonly string[];
  readonly tasks?: readonly string[];
}

export const DEFAULT_ASSEMBLY: readonly string[] = Object.freeze([
  "builtin:read",
  "builtin:bash",
  "builtin:edit",
  "builtin:write",
  "skills:registry",
  "session:store",
]);

export function listAssembly(): readonly string[] {
  return [...DEFAULT_ASSEMBLY];
}

function defineAgentPlugin(name: string, contributions: readonly PluginContribution[]): AgentPlugin {
  if (typeof name !== "string" || name.length === 0) throw new Error("plugin: name required");
  const normalized = Object.freeze([...contributions]);
  let installed = false;
  return {
    kind: "AgentPlugin",
    name,
    contributions: normalized,
    install() {
      if (installed) throw new Error("PLUGIN_ALREADY_INSTALLED");
      installed = true;
      return () => {
        installed = false;
      };
    },
  };
}

export function definePiExtension(
  name: string,
  define: (api: PiExtensionApi) => void
): AgentPlugin {
  if (typeof define !== "function") throw new Error("pi extension: expected a builder");
  const contributions: PluginContribution[] = [];
  const api: PiExtensionApi = {
    registerTool(tool) {
      contributions.push({ kind: "tool", tool });
    },
    on(event, handler) {
      contributions.push({ kind: "hook", event, handler });
    },
    addSection(text) {
      contributions.push({ kind: "section", text });
    },
  };
  define(api);
  return defineAgentPlugin(name, contributions);
}

export function defineDurableExtension(name: string, spec: DurableExtensionSpec): AgentPlugin {
  if (spec === null || typeof spec !== "object") {
    throw new Error("durable extension: expected a spec");
  }
  const contributions: PluginContribution[] = [];
  for (const tool of spec.tools ?? []) contributions.push({ kind: "tool", tool });
  for (const hook of spec.hooks ?? []) {
    contributions.push({ kind: "hook", event: hook.event, handler: hook.handler });
  }
  for (const text of spec.sections ?? []) contributions.push({ kind: "section", text });
  for (const entry of spec.wraps ?? []) contributions.push({ kind: "wrap", name: entry });
  for (const entry of spec.tasks ?? []) contributions.push({ kind: "task", name: entry });
  return defineAgentPlugin(name, contributions);
}

function builtinTools(): PluginTool[] {
  return ["read", "bash", "edit", "write"].map((name) => ({
    name,
    execute: () => ({ ok: true, tool: name }),
  }));
}

function defaultContributions(): PluginContribution[] {
  const contributions: PluginContribution[] = [];
  for (const tool of builtinTools()) contributions.push({ kind: "tool", tool });
  contributions.push({ kind: "service", name: "skills:registry" });
  contributions.push({ kind: "service", name: "session:store" });
  return contributions;
}

export interface AgentStreamRequest {
  readonly messages: readonly AgentMessage[];
}

export type AgentStreamFn = (request: AgentStreamRequest) => AsyncIterable<string>;

export interface AgentOptions {
  readonly streamFn?: AgentStreamFn;
  readonly plugins?: readonly AgentPlugin[];
  readonly includeBuiltins?: boolean;
}

export interface Agent {
  prompt(text: string): Promise<readonly AgentMessage[]>;
  continue(): Promise<readonly AgentMessage[]>;
  subscribe(listener: AgentListener): Disposer;
  abort(): void;
  waitForIdle(): Promise<void>;
  readonly aborted: boolean;
  readonly state: AgentState;
  readonly toolNames: readonly string[];
  readonly assembly: readonly string[];
}

export function createAgent(options: AgentOptions = {}): Agent {
  const stream = createEventStream();
  const streamFn = options.streamFn;
  const includeBuiltins = options.includeBuiltins !== false;
  const plugins = options.plugins ?? [];
  const contributions: PluginContribution[] = includeBuiltins ? defaultContributions() : [];
  for (const plugin of plugins) contributions.push(...plugin.contributions);

  const toolNames = contributions
    .filter((item): item is Extract<PluginContribution, { kind: "tool" }> => item.kind === "tool")
    .map((item) => item.tool.name);
  const assembly = includeBuiltins ? listAssembly() : [];

  let aborted = false;

  async function runTurn(userText?: string): Promise<readonly AgentMessage[]> {
    if (aborted) return stream.getState().messages;
    await stream.emit({ type: "agent_start" });
    await stream.emit({ type: "turn_start" });

    if (userText !== undefined) {
      const message: AgentMessage = { role: "user", content: userText };
      await stream.emit({ type: "message_start", message });
      await stream.emit({ type: "message_end", message });
    }

    if (streamFn !== undefined) {
      let content = "";
      for await (const chunk of streamFn({ messages: stream.getState().messages })) {
        content += chunk;
      }
      const message: AgentMessage = { role: "assistant", content };
      await stream.emit({ type: "message_start", message });
      await stream.emit({ type: "message_end", message });
    }

    const last = stream.getState().messages.at(-1);
    if (last !== undefined) {
      await stream.emit({ type: "turn_end", message: last, toolResults: [] });
    }
    await stream.emit({ type: "agent_end", messages: stream.getState().messages });
    return stream.getState().messages;
  }

  return {
    prompt(text) {
      if (typeof text !== "string") throw new Error("prompt: expected a string");
      return runTurn(text);
    },
    continue: () => runTurn(),
    subscribe: (listener) => stream.subscribe(listener),
    abort() {
      aborted = true;
    },
    waitForIdle: () => stream.waitForIdle(),
    get aborted() {
      return aborted;
    },
    get state() {
      return stream.getState();
    },
    toolNames,
    assembly,
  };
}
