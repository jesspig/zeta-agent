import { For, createSignal, onCleanup, onMount } from "solid-js";
import { createAgentSignals, type EventSource, type StatusMessage } from "../signal";

const STATUS_LABEL: Record<NonNullable<StatusMessage>, string> = {
  working: "working",
  retry: "retry",
  compaction: "compaction",
  blocked: "blocked",
};

const STATUS_COLOR = {
  working: "#58a6ff",
  retry: "#d29922",
  compaction: "#d2a8ff",
  blocked: "#ff7b72",
} as const;

export interface StatusBorderProps {
  readonly source: EventSource;
}

export function StatusBorder(props: StatusBorderProps) {
  const signals = createAgentSignals(props.source);
  const [status, setStatus] = createSignal<string>("idle");

  onMount(() => {
    const offStatusMessage = signals.statusMessage.subscribe((value) => {
      setStatus(value ? STATUS_LABEL[value] : "idle");
    });
    const offStatus = signals.status.subscribe((value) => {
      if (signals.statusMessage() === null) setStatus(value === "idle" ? "idle" : "working");
    });
    onCleanup(() => {
      offStatusMessage();
      offStatus();
      signals.dispose();
    });
  });

  const color = () => {
    const value = signals.statusMessage();
    return value ? STATUS_COLOR[value] : "#8b949e";
  };

  return (
    <box border={true} borderColor={color()}>
      <text fg={color()}>{`[${status()}]`}</text>
    </box>
  );
}

export interface WorkIndicatorProps {
  /** 可选事件源：提供时跟随 statusMessage/status 信号更新；纯展示时可直接传 status。 */
  readonly source?: EventSource;
  readonly status?: string;
}

/**
 * T-02 编辑器上方的工作指示器边框：轻量复用 StatusBorder 的状态语义，
 * 以单行带边框文本呈现当前工作状态，不破坏 StatusBorder 既有功能。
 */
export function WorkIndicator(props: WorkIndicatorProps) {
  const [status, setStatus] = createSignal<string>(props.status ?? "idle");

  if (props.source !== undefined) {
    const signals = createAgentSignals(props.source);
    onMount(() => {
      const offStatusMessage = signals.statusMessage.subscribe((value) => {
        setStatus(value ? STATUS_LABEL[value] : "idle");
      });
      const offStatus = signals.status.subscribe((value) => {
        if (signals.statusMessage() === null) setStatus(value === "idle" ? "idle" : "working");
      });
      onCleanup(() => {
        offStatusMessage();
        offStatus();
        signals.dispose();
      });
    });
  }

  const value = () => props.status ?? status();
  const color = () => STATUS_COLOR[value() as NonNullable<StatusMessage>] ?? "#8b949e";

  return (
    <box border={true} borderColor={color()}>
      <text fg={color()}>{`[${value()}]`}</text>
    </box>
  );
}

export interface FollowScrollBoxProps {
  readonly source: EventSource;
  readonly lines: readonly string[];
}

/** 自动跟随的新消息滚动盒：stickyScroll 让新内容到达时自动滚到底部。 */
export function FollowScrollBox(props: FollowScrollBoxProps) {
  return (
    <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
      <For each={props.lines}>{(line) => <text>{line}</text>}</For>
    </scrollbox>
  );
}
