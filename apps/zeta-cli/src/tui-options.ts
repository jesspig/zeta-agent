import type { RuntimeResources, RuntimeTuiOptions } from "@zeta-agent/tui";
import type { Agent } from "@zeta-agent/agent";

export interface TuiHostOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly models?: readonly string[];
  readonly onModelChange?: (model: string) => void;
  readonly onConnect?: (url: string, key: string) => void;
  readonly connection?: { readonly url?: string; readonly key?: string };
  readonly reasoningEffort?: string;
  readonly onEffortChange?: (effort: string) => void;
  readonly onNewSession?: () => void | Promise<void>;
  readonly resources?: RuntimeResources;
  readonly commandCatalog?: RuntimeTuiOptions["commandCatalog"];
  readonly onCommand?: (text: string) => void | Promise<void>;
  readonly onAbort?: () => void;
}

/** 把 agent 事件源与命令处理器封装为 CLI→TUI 共用的 options 契约（FR-12）。 */
export function buildTuiOptions(
  agent: Agent,
  version: string,
  handleCommand: (text: string) => void | Promise<void>,
  host: TuiHostOptions = {},
): RuntimeTuiOptions {
  return {
    title: `zeta v${version}`,
    source: { subscribe: (listener) => agent.subscribe(listener) },
    commands: (text) => handleCommand(text),
    onCommand: host.onCommand,
    onAbort: host.onAbort,
    commandCatalog: host.commandCatalog,
    commandList: [
      { id: "help", title: "显示帮助" },
      { id: "clear", title: "清空当前会话" },
    ],
    mode: "fullscreen",
    onSubmit: (text) => handleCommand(text),
    cwd: host.cwd,
    model: host.model,
    models: host.models,
    onModelChange: host.onModelChange,
    onConnect: host.onConnect,
    connection: host.connection,
    reasoningEffort: host.reasoningEffort,
    onEffortChange: host.onEffortChange,
    onNewSession: host.onNewSession,
    provider: host.provider,
    resources: host.resources,
  };
}
