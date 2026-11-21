import { createSignal, onCleanup } from "solid-js";
import { createAgentSignals, type EventSource, type AgentStatus, type StatusMessage } from "../signal";
import { contextBudget, type ContextBudget } from "../hud";
import { FooterView } from "./footer";

const ESTIMATED_TOKENS_PER_MESSAGE = 2000;
const CONTEXT_LIMIT = 128000;

export interface FooterBridgeProps {
  readonly source?: EventSource;
  readonly model?: string;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  working: "working",
  retry: "retry",
  compaction: "compacting",
  blocked: "blocked",
};

/** 把 AgentSignals 桥接为真实状态栏：status/statusMessage 来自事件，budget 由消息数估算。 */
export function FooterBridge(props: FooterBridgeProps) {
  const [status, setStatus] = createSignal<AgentStatus>("idle");
  const [statusMessage, setStatusMessage] = createSignal<StatusMessage>(null);
  const [messageCount, setMessageCount] = createSignal(0);

  const signals = props.source === undefined ? undefined : createAgentSignals(props.source);
  if (signals !== undefined) {
    const offStatus = signals.status.subscribe(setStatus);
    const offStatusMessage = signals.statusMessage.subscribe(setStatusMessage);
    const offMessages = signals.messages.subscribe((list) => setMessageCount(list.length));
    onCleanup(() => {
      offStatus();
      offStatusMessage();
      offMessages();
      signals.dispose();
    });
  }

  const budget = (): ContextBudget =>
    contextBudget(messageCount() * ESTIMATED_TOKENS_PER_MESSAGE, CONTEXT_LIMIT);

  return (
    <FooterView
      model={props.model ?? "zeta"}
      status={status()}
      budget={budget()}
      retry={STATUS_LABEL[statusMessage() ?? ""] || undefined}
    />
  );
}
