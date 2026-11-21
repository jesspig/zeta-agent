import type { RuntimeTuiOptions } from "@zeta-agent/tui";
import type { Agent } from "@zeta-agent/agent";

/** 把 agent 事件源与命令处理器封装为 CLI→TUI 共用的 options 契约（FR-12）。 */
export function buildTuiOptions(
  agent: Agent,
  version: string,
  handleCommand: (text: string) => void | Promise<void>,
): RuntimeTuiOptions {
  return {
    title: `zeta v${version}`,
    source: { subscribe: (listener) => agent.subscribe(listener) },
    commands: (text) => handleCommand(text),
    mode: "fullscreen",
    onSubmit: (text) => handleCommand(text),
  };
}
