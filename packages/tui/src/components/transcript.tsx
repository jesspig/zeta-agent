import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { AgentMessage } from "@zeta-agent/agent";
import { createAgentSignals, type EventSource } from "../signal";
import {
  applyTimelineEvent,
  createTimelineState,
  type TimelineAssistantEntry,
  type TimelineEntry,
  type TimelineNoticeEntry,
  type TimelineState,
  type TimelineToolEntry,
  type TimelineUserEntry,
} from "../timeline";
import { presentTool, type StyledLine, type StyledRun } from "../tool-view";
import { parseMarkdown } from "../markdown-blocks";
import { useTheme } from "../theme-context";


export interface TranscriptResources {
  readonly models?: readonly string[];
  readonly prompts?: readonly string[];
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
}

export interface TranscriptProps {
  readonly source: EventSource;
  readonly initialMessages?: readonly AgentMessage[];
  readonly cwd?: string;
  readonly resources?: TranscriptResources;
  /** 变化时重置时间线（/clear /new）。 */
  readonly resetKey?: number;
  /** 宿主注入的提示行（追加在时间线末尾）。 */
  readonly notices?: readonly TimelineNoticeEntry[];
}

/** 一行样式化文本：run → span，保留主题 token 与粗斜体属性。 */
export function StyledLineText(props: { readonly line: StyledLine }) {
  const theme = useTheme();
  return (
    <text>
      <For each={props.line}>
        {(run: StyledRun) => {
          const attributes = () =>
            (run.bold ? TextAttributes.BOLD : 0) | (run.italic ? TextAttributes.ITALIC : 0);
          return (
            <span style={{ fg: run.token === undefined ? undefined : theme.color(run.token), bold: run.bold, italic: run.italic }}>
              {run.text}
            </span>
          );
        }}
      </For>
    </text>
  );
}

/** 一段 Markdown：逐行投影为样式化文本。 */
export function MarkdownView(props: { readonly text: string; readonly italic?: boolean; readonly token?: StyledRun["token"] }) {
  const theme = useTheme();
  const lines = createMemo(() => parseMarkdown(props.text));
  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => (
          <text>
            <Show when={line.length > 0} fallback={<span style={{}}>{" "}</span>}>
              <For each={line}>
                {(run) => (
                  <span style={{ fg: theme.color(run.token ?? props.token ?? "text"), bold: run.bold, italic: props.italic }}>
                    {run.text}
                  </span>
                )}
              </For>
            </Show>
          </text>
        )}
      </For>
    </box>
  );
}

function UserMessage(props: { readonly entry: TimelineUserEntry }) {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={theme.color("userMessageBg")}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <MarkdownView text={props.entry.text} token="userMessageText" />
    </box>
  );
}

function ThinkingRun(props: { readonly text: string; readonly expanded: boolean; readonly streaming: boolean }) {
  const theme = useTheme();
  return (
    <Show
      when={props.expanded}
      fallback={
        <text fg={theme.color("thinkingText")} attributes={TextAttributes.ITALIC}>
          {"Thinking..."}
        </text>
      }
    >
      <box flexDirection="column">
        <MarkdownView text={props.text} italic={true} token="thinkingText" />
      </box>
    </Show>
  );
}

function AssistantMessage(props: { readonly entry: TimelineAssistantEntry; readonly thinkingExpanded: boolean }) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <Show when={props.entry.thinking.trim().length > 0}>
        <ThinkingRun
          text={props.entry.thinking}
          expanded={props.thinkingExpanded}
          streaming={props.entry.streaming}
        />
        <Show when={props.entry.text.trim().length > 0}>
          <text>{" "}</text>
        </Show>
      </Show>
      <Show when={props.entry.text.trim().length > 0}>
        <MarkdownView
          text={props.entry.text}
          token={props.entry.text.trimStart().startsWith("Error:") ? "error" : "text"}
        />
      </Show>
    </box>
  );
}

function ToolBlock(props: { readonly entry: TimelineToolEntry; readonly expanded: boolean; readonly cwd?: string }) {
  const theme = useTheme();
  const view = createMemo(() => presentTool(props.entry, { cwd: props.cwd, expanded: props.expanded }));
  const background = () => {
    if (props.entry.status === "running") return theme.color("toolPendingBg");
    if (props.entry.status === "error") return theme.color("toolErrorBg");
    return theme.color("toolSuccessBg");
  };
  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={background()}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      marginBottom={1}
    >
      <StyledLineText line={view().header} />
      <Show when={view().body.length > 0}>
        <text> </text>
        <For each={view().body}>{(line) => <StyledLineText line={line} />}</For>
      </Show>
      <Show when={view().note !== undefined}>
        <text> </text>
        <StyledLineText line={view().note!} />
      </Show>
    </box>
  );
}

function Notice(props: { readonly entry: TimelineNoticeEntry }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <text fg={theme.color(props.entry.tone)}>{props.entry.text}</text>
    </box>
  );
}

function StartupHeader(props: { readonly resources?: TranscriptResources }) {
  const theme = useTheme();
  const rows = createMemo<readonly { readonly text: string; readonly token: "muted" | "warning" | "info" | "success" }[]>(() => {
    const resources = props.resources;
    const out: { text: string; token: "muted" | "warning" | "info" | "success" }[] = [];
    if ((resources?.models?.length ?? 0) > 0) {
      out.push({ text: `[Models] ${resources!.models!.join(", ")}`, token: "muted" });
    }
    if ((resources?.prompts?.length ?? 0) > 0) {
      out.push({ text: `[Prompts] ${resources!.prompts!.map((name) => `/${name}`).join(", ")}`, token: "warning" });
    }
    if ((resources?.skills?.length ?? 0) > 0) {
      out.push({ text: `[Skills] ${resources!.skills!.join(", ")}`, token: "info" });
    }
    if ((resources?.extensions?.length ?? 0) > 0) {
      out.push({ text: `[Extensions] ${resources!.extensions!.join(", ")}`, token: "info" });
    }
    if (out.length > 0) out.push({ text: " ", token: "muted" });
    out.push({ text: "✓ New session started", token: "success" });
    return out;
  });
  return (
    <box flexDirection="column" marginBottom={1}>
      <text>
        <For each={rows()}>
          {(row, index) => (
            <span style={{ fg: theme.color(row.token) }}>
              {row.text + (index() < rows().length - 1 ? "\n" : "")}
            </span>
          )}
        </For>
      </text>
    </box>
  );
}

/**
 * 对话视口：单一时间线内联渲染用户消息、思考、助手正文与工具执行。
 * Ctrl+O 全局展开/折叠工具输出，Ctrl+T 全局展开/折叠思考块（与目标终端 UI 一致）。
 */
export function Transcript(props: TranscriptProps) {
  const signals = createAgentSignals(props.source);
  const dimensions = useTerminalDimensions();
  const [state, setState] = createSignal<TimelineState>(createTimelineState(props.initialMessages ?? []));
  const [toolsExpanded, setToolsExpanded] = createSignal(false);
  const [thinkingExpanded, setThinkingExpanded] = createSignal(true);

  let lastResetKey = props.resetKey ?? 0;
  const resetIfNeeded = (): void => {
    const key = props.resetKey ?? 0;
    if (key !== lastResetKey) {
      lastResetKey = key;
      const fresh = createTimelineState();
      signals.timeline.set(fresh);
      setState(fresh);
    }
  };

  createEffect(() => {
    void props.resetKey;
    resetIfNeeded();
  });

  onMount(() => {
    const off = signals.timeline.subscribe((next) => {
      resetIfNeeded();
      setState(next);
    });
    onCleanup(() => {
      off();
      signals.dispose();
    });
  });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      key.stopPropagation();
      setToolsExpanded((value) => !value);
      return;
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault();
      key.stopPropagation();
      setThinkingExpanded((value) => !value);
    }
  });

  const entries = createMemo(() => state().entries);
  const hasConversation = createMemo(() => entries().length > 0);
  const width = createMemo(() => Math.max(20, dimensions().width));

  const renderEntry = (entry: TimelineEntry): JSX.Element => {
    if (entry.kind === "user") return <UserMessage entry={entry} />;
    if (entry.kind === "tool") {
      return <ToolBlock entry={entry} expanded={toolsExpanded()} cwd={props.cwd} />;
    }
    if (entry.kind === "notice") return <Notice entry={entry} />;
    return <AssistantMessage entry={entry} thinkingExpanded={thinkingExpanded()} />;
  };

  void width;
  return (
    <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
      <box flexDirection="column" width="100%">
        <Show when={!hasConversation()}>
          <StartupHeader resources={props.resources} />
        </Show>
        <For each={entries()}>{(entry) => renderEntry(entry)}</For>
        <For each={props.notices ?? []}>{(notice) => <Notice entry={notice} />}</For>
      </box>
    </scrollbox>
  );
}

export { applyTimelineEvent };
