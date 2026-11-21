import { createSignal, onCleanup } from "solid-js";
import { createAgentSignals, type EventSource, type AgentStatus, type StatusMessage } from "../signal";
import { contextBudget, type ContextBudget } from "../hud";
import { FooterView, type FooterMetrics } from "./footer";

const ESTIMATED_TOKENS_PER_MESSAGE = 2000;
const CONTEXT_LIMIT = 128000;

export interface FooterBridgeProps {
  readonly source?: EventSource;
  readonly model?: string;
  /** 遥测覆盖：真实 token/成本/分支来自宿主时由此注入。 */
  readonly telemetry?: {
    readonly pwd?: string;
    readonly home?: string;
    readonly branch?: string;
    readonly session?: string;
    readonly metrics?: FooterMetrics;
    readonly provider?: string;
    readonly modelId?: string;
    readonly thinking?: boolean;
  };
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  working: "working",
  retry: "retry",
  compaction: "compacting",
  blocked: "blocked",
};

/** 从进程环境推断默认路径信息，使默认界面即呈现双行高保真 footer。 */
function defaultTelemetry() {
  const pwd = typeof process !== "undefined" ? process.cwd() : "";
  const home = typeof process !== "undefined" ? (process.env.USERPROFILE ?? process.env.HOME ?? "") : "";
  return { pwd, home };
}

/** 把 AgentSignals 桥接为真实状态栏：默认即双行高保真布局。 */
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

  const defaults = defaultTelemetry();
  const telemetry = props.telemetry;

  return (
    <FooterView
      model={props.model ?? "zeta"}
      status={status()}
      budget={budget()}
      retry={STATUS_LABEL[statusMessage() ?? ""] || undefined}
      statusText={telemetry ? STATUS_LABEL[statusMessage() ?? ""] || undefined : undefined}
      pwd={telemetry?.pwd ?? defaults.pwd}
      home={telemetry?.home ?? defaults.home}
      branch={telemetry?.branch}
      session={telemetry?.session}
      metrics={telemetry?.metrics}
      provider={telemetry?.provider}
      modelId={telemetry?.modelId ?? props.model}
      thinking={telemetry?.thinking}
    />
  );
}
