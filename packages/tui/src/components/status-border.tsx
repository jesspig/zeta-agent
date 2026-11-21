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
