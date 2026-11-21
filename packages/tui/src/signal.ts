import type { AgentEvent, AgentMessage } from "@zeta-agent/agent";

export interface ToolResultMessage extends AgentMessage {
  readonly toolCallId?: string;
}

export type Signal<T> = (() => T) & {
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
};

export function createSignal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const signal = (() => value) as Signal<T>;
  signal.set = (next) => {
    if (Object.is(value, next)) return;
    value = next;
    for (const listener of [...listeners]) listener(value);
  };
  signal.subscribe = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return signal;
}

export interface EventSource {
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export type AgentStatus = "idle" | "streaming" | "tool";
export type ToolStateStatus = "running" | "done" | "error";

export interface ToolState {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly status: ToolStateStatus;
  readonly durationMs?: number;
}

export type StatusMessage = "working" | "retry" | "compaction" | "blocked" | null;

export interface AgentSignals {
  readonly messages: Signal<readonly AgentMessage[]>;
  readonly streaming: Signal<AgentMessage | null>;
  readonly pendingTools: Signal<ReadonlySet<string>>;
  readonly status: Signal<AgentStatus>;
  readonly thinking: Signal<string>;
  readonly toolStates: Signal<ReadonlyMap<string, ToolState>>;
  readonly completedTools: Signal<readonly ToolResultMessage[]>;
  readonly statusMessage: Signal<StatusMessage>;
  dispose(): void;
}

function thinkingText(message: AgentMessage): string | null {
  const content = message.content;
  if (typeof content === "object" && content !== null && "type" in content) {
    const record = content as { readonly type?: unknown; readonly text?: unknown };
    if (record.type === "thinking" && typeof record.text === "string") return record.text;
  }
  return null;
}

export function createAgentSignals(source: EventSource): AgentSignals {
  const messages = createSignal<readonly AgentMessage[]>([]);
  const streaming = createSignal<AgentMessage | null>(null);
  const pendingTools = createSignal<ReadonlySet<string>>(new Set<string>());
  const status = createSignal<AgentStatus>("idle");
  const thinking = createSignal<string>("");
  const toolStates = createSignal<ReadonlyMap<string, ToolState>>(new Map<string, ToolState>());
  const completedTools = createSignal<readonly ToolResultMessage[]>([]);
  const statusMessage = createSignal<StatusMessage>(null);

  const dispose = source.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        status.set("streaming");
        break;
      case "agent_end":
        messages.set(event.messages);
        streaming.set(null);
        status.set("idle");
        break;
      case "turn_start":
        statusMessage.set("working");
        break;
      case "turn_end": {
        statusMessage.set(null);
        const ordered = event.toolResults.filter((result) => result.role === "toolResult");
        completedTools.set(ordered);
        break;
      }
      case "message_start":
        streaming.set(event.message);
        status.set("streaming");
        break;
      case "message_update": {
        streaming.set(event.message);
        status.set("streaming");
        const text = thinkingText(event.message);
        if (text !== null) thinking.set(text);
        break;
      }
      case "message_end":
        streaming.set(null);
        thinking.set("");
        messages.set([...messages(), event.message]);
        break;
      case "tool_execution_start": {
        const nextPending = new Set(pendingTools());
        nextPending.add(event.toolCallId);
        pendingTools.set(nextPending);
        const nextStates = new Map(toolStates());
        nextStates.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: "running",
        });
        toolStates.set(nextStates);
        status.set("tool");
        break;
      }
      case "tool_execution_update": {
        const nextStates = new Map(toolStates());
        const current = nextStates.get(event.toolCallId);
        if (current) {
          nextStates.set(event.toolCallId, { ...current, args: event.args });
          toolStates.set(nextStates);
        }
        break;
      }
      case "tool_execution_end": {
        const nextPending = new Set(pendingTools());
        nextPending.delete(event.toolCallId);
        pendingTools.set(nextPending);
        const nextStates = new Map(toolStates());
        const current = nextStates.get(event.toolCallId);
        nextStates.set(event.toolCallId, {
          id: event.toolCallId,
          name: current?.name ?? event.toolName,
          args: current?.args ?? {},
          status: event.isError ? "error" : "done",
          durationMs: event.durationMs,
        });
        toolStates.set(nextStates);
        status.set(nextPending.size > 0 ? "tool" : "streaming");
        break;
      }
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  });

  return {
    messages,
    streaming,
    pendingTools,
    status,
    thinking,
    toolStates,
    completedTools,
    statusMessage,
    dispose,
  };
}
