import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { AgentMessage } from "@zeta-agent/agent";
import { createAgentSignals, type EventSource } from "../signal";
import type { RuntimeMessage } from "../runtime-types";
import { CodeContent, MarkdownContent, markdownPlain } from "./markdown";
import { ToolBox } from "./tool-box";
import { ThinkingBlock } from "./thinking";
import { StatusBorder } from "./status-border";
import { DiffView } from "./diff-view";

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
  const [thinking, setThinking] = createSignal<string>("");

  onMount(() => {
    const offStreaming = signals.streaming.subscribe((message) => {
      setStreaming(message ? messageText(message) : "");
    });
    const offMessages = signals.messages.subscribe((list) => {
      setMessages([...list]);
    });
    const offThinking = signals.thinking.subscribe(setThinking);
    onCleanup(() => {
      offStreaming();
      offMessages();
      offThinking();
      signals.dispose();
    });
  });

  const hasStreaming = createMemo(() => streaming().length > 0);
  props.onRender?.();

  return (
    <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
      <Show when={hasStreaming()} fallback={<text>IDLE</text>}>
        <text>{streaming()}</text>
      </Show>
      <Show when={thinking().length > 0}>
        <ThinkingBlock text={thinking()} expanded={false} />
      </Show>
      <For each={messages()}>
        {(message) => (
          <text>{`[${message.role}] ${messageText(message)}`}</text>
        )}
      </For>
    </scrollbox>
  );
}

export interface RichMessageListProps extends MessageListProps {
  readonly showTools?: boolean;
  readonly diffs?: readonly { readonly before: string; readonly after: string }[];
}

/** 带工具盒的富消息列表：工具事件由内嵌 ToolBox 独立订阅同一事件源。 */
export function RichMessageList(props: RichMessageListProps) {
  return (
    <box flexDirection="column">
      <StatusBorder source={props.source} />
      <MessageList source={props.source} onRender={props.onRender} />
      <Show when={props.diffs && props.diffs.length > 0}>
        <For each={props.diffs}>
          {(diff) => <DiffView before={diff.before} after={diff.after} />}
        </For>
      </Show>
      <Show when={props.showTools !== false}>
        <ToolBox source={props.source} />
      </Show>
    </box>
  );
}
