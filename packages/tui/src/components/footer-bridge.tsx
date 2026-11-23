import { createSignal, onCleanup } from "solid-js";
import { createAgentSignals, type EventSource, type AgentStatus, type StatusMessage } from "../signal";
import { contextBudget, type ContextBudget } from "../hud";
import { DEFAULT_CONTEXT_LIMIT } from "../usage";
import type { AgentUsageTelemetry } from "../telemetry-types";
import { FooterView } from "./footer";

export interface FooterBridgeProps {
  readonly source?: EventSource;
  readonly model?: string;
  /** 覆盖默认 cwd（例如 CLI 显式传入）。 */
  readonly pwd?: string;
  readonly provider?: string;
  readonly modelId?: string;
  /** 真实遥测：token/成本/分支/会话由宿主或 agent 事件源提供。 */
  readonly telemetry?: AgentUsageTelemetry;
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

  const signals = props.source === undefined ? undefined : createAgentSignals(props.source);
  if (signals !== undefined) {
    const offStatus = signals.status.subscribe(setStatus);
    const offStatusMessage = signals.statusMessage.subscribe(setStatusMessage);
    onCleanup(() => {
      offStatus();
      offStatusMessage();
      signals.dispose();
    });
  }

  const telemetry = () => props.telemetry;
  const usedTokens = (): number => {
    const current = telemetry();
    const metrics = current?.metrics;
    return (
      current?.usedTokens ??
      (metrics === undefined ? 0 : metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens)
    );
  };
  const budget = (): ContextBudget =>
    contextBudget(usedTokens(), telemetry()?.contextLimit ?? DEFAULT_CONTEXT_LIMIT);

  const defaults = defaultTelemetry();

  return (
    <FooterView
      model={props.model ?? "zeta"}
      status={status()}
      budget={budget()}
      retry={STATUS_LABEL[statusMessage() ?? ""] || undefined}
      statusText={telemetry() ? STATUS_LABEL[statusMessage() ?? ""] || undefined : undefined}
      pwd={telemetry()?.pwd ?? props.pwd ?? defaults.pwd}
      home={telemetry()?.home ?? defaults.home}
      branch={telemetry()?.branch}
      session={telemetry()?.session}
      metrics={telemetry()?.metrics}
      provider={telemetry()?.provider}
      modelId={telemetry()?.modelId ?? props.model}
      thinking={telemetry()?.thinking}
    />
  );
}
