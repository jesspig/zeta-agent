import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { AgentMessage } from "@zeta-agent/agent";
import { createAgentSignals, type EventSource } from "../signal";
import type { RuntimeMessage } from "../runtime-types";
import { useTheme } from "../theme-context";
import { useTerminalDimensions } from "@opentui/solid";
import { CodeContent, MarkdownContent, markdownPlain } from "./markdown";
import { ToolBox } from "./tool-box";
import { ThinkingBlock } from "./thinking";
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

function isUser(message: AgentMessage | RuntimeMessage): boolean {
  return message.role === "user";
}

export interface MessageListProps {
  readonly source: EventSource;
  readonly onRender?: () => void;
  /** 启动资源信息（模型清单/提示词/扩展等），在会话开始标记上方展示。 */
  readonly resources?: Readonly<{
    readonly models?: readonly string[];
    readonly prompts?: readonly string[];
    readonly extensions?: readonly string[];
  }>;
}

/**
 * 对话消息列表：按角色高保真渲染。
 * - 用户消息：整行底色高亮块（参考终端 UI 的 userMessageBg）
 * - 助手消息：正文流式 Markdown，思考块可折叠
 * - 会话起始：带成功符号的会话状态行
 */
export function MessageList(props: MessageListProps) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
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
  const hasConversation = createMemo(() => messages().length > 0 || hasStreaming());
  const innerWidth = createMemo(() => Math.max(1, dimensions().width - 2));
  props.onRender?.();

  return (
    <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
      {/* 启动资源信息区 */}
      <Show when={!hasConversation() && props.resources}>
        {(res: () => NonNullable<MessageListProps["resources"]>) => (
          <box flexDirection="column" paddingBottom={1}>
            <Show when={res().models && res().models!.length > 0}>
              <text fg={theme.color("muted")}>{`[Models] ${res().models!.join(", ")}`}</text>
            </Show>
            <Show when={res().prompts && res().prompts!.length > 0}>
              <text fg={theme.color("warning")}>{`[Prompts] ${res().prompts!.map((p: string) => `/${p}`).join(", ")}`}</text>
            </Show>
            <Show when={res().extensions && res().extensions!.length > 0}>
              <text fg={theme.color("info")}>{`[Extensions] ${res().extensions!.join(", ")}`}</text>
            </Show>
          </box>
        )}
      </Show>

      {/* 会话状态行 */}
      <Show when={!hasConversation()}>
        <box height={1} marginBottom={1}>
          <text fg={theme.color("success")}>{"✓ New session started"}</text>
        </box>
      </Show>

      {/* 流式输出中的助手消息 */}
      <Show when={hasStreaming()}>
        <box flexDirection="column" marginBottom={1}>
          <MarkdownContent content={markdownPlain(streaming())} />
        </box>
      </Show>

      {/* 思考块 */}
      <Show when={thinking().length > 0}>
        <ThinkingBlock text={thinking()} expanded={false} />
      </Show>

      {/* 历史消息：按角色高保真渲染 */}
      <For each={messages()}>
        {(message) =>
          isUser(message) ? (
            <box
              flexDirection="column"
              width={innerWidth()}
              backgroundColor={theme.color("userMessageBg")}
              paddingLeft={1}
              paddingRight={1}
              marginBottom={1}
            >
              <text fg={theme.color("userMessageText")}>{messageText(message)}</text>
            </box>
          ) : message.role === "toolResult" ? (
            <box flexDirection="column" marginBottom={1}>
              <text fg={theme.color("muted")}>{messageText(message)}</text>
            </box>
          ) : (
            <box flexDirection="column" marginBottom={1}>
              <MarkdownContent content={markdownPlain(messageText(message))} />
            </box>
          )
        }
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
      <MessageList source={props.source} onRender={props.onRender} resources={props.resources} />
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
