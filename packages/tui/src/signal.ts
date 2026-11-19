import type { AgentEvent, AgentMessage } from "@zeta-agent/agent";

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

export interface AgentSignals {
  readonly messages: Signal<readonly AgentMessage[]>;
  readonly streaming: Signal<AgentMessage | null>;
  readonly pendingTools: Signal<ReadonlySet<string>>;
  readonly status: Signal<AgentStatus>;
  dispose(): void;
}

export function createAgentSignals(source: EventSource): AgentSignals {
  const messages = createSignal<readonly AgentMessage[]>([]);
  const streaming = createSignal<AgentMessage | null>(null);
  const pendingTools = createSignal<ReadonlySet<string>>(new Set<string>());
  const status = createSignal<AgentStatus>("idle");

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
        break;
      case "turn_end":
        break;
      case "message_start":
        streaming.set(event.message);
        status.set("streaming");
        break;
      case "message_update":
        streaming.set(event.message);
        status.set("streaming");
        break;
      case "message_end":
        streaming.set(null);
        messages.set([...messages(), event.message]);
        break;
      case "tool_execution_start": {
        const next = new Set(pendingTools());
        next.add(event.toolCallId);
        pendingTools.set(next);
        status.set("tool");
        break;
      }
      case "tool_execution_update":
        break;
      case "tool_execution_end": {
        const next = new Set(pendingTools());
        next.delete(event.toolCallId);
        pendingTools.set(next);
        status.set(next.size > 0 ? "tool" : "streaming");
        break;
      }
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  });

  return { messages, streaming, pendingTools, status, dispose };
}
