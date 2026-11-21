import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { AgentMessage } from "@zeta-agent/agent";
import { createAgentSignals, type EventSource } from "../signal";
import type { RuntimeMessage } from "../runtime-types";
import { CodeContent, MarkdownContent, markdownPlain } from "./markdown";

export { CodeContent, MarkdownContent, markdownPlain } from "./markdown";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { readonly text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function messageText(message: AgentMessage | RuntimeMessage): string {
  return contentText(message.content);
}

export interface MessageListProps {
  readonly source: EventSource;
  readonly onRender?: () => void;
}

export function MessageList(props: MessageListProps) {
  const signals = createAgentSignals(props.source);
  const [streaming, setStreaming] = createSignal<string>("");
  const [messages, setMessages] = createSignal<readonly AgentMessage[]>([]);

  onMount(() => {
    const offStreaming = signals.streaming.subscribe((message) => {
      setStreaming(message ? messageText(message) : "");
    });
    const offMessages = signals.messages.subscribe((list) => {
      setMessages([...list]);
    });
    onCleanup(() => {
      offStreaming();
      offMessages();
      signals.dispose();
    });
  });

  const hasStreaming = createMemo(() => streaming().length > 0);
  props.onRender?.();

  return (
    <box flexDirection="column">
      <Show when={hasStreaming()} fallback={<text>IDLE</text>}>
        <text>{streaming()}</text>
      </Show>
      <For each={messages()}>
        {(message) => (
          <text>{`[${message.role}] ${messageText(message)}`}</text>
        )}
      </For>
    </box>
  );
}
