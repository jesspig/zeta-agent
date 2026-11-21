import { useTerminalDimensions } from "@opentui/solid";
import type { ContextBudget } from "../hud";
import { useTheme } from "../theme-context";

/** 第 2 行右侧的遥测契约：真实 token/成本尚未从 Agent 接通，由调用方注入或登记占位。 */
export interface FooterMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheHitPercent: number;
  readonly costUsd: number;
}

export interface FooterViewProps {
  readonly model: string;
  readonly status: string;
  readonly budget: ContextBudget;
  readonly retry?: string;
  readonly pwd?: string;
  readonly home?: string;
  readonly branch?: string;
  readonly session?: string;
  readonly metrics?: FooterMetrics;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinking?: boolean;
  /** 扩展状态行文本（setStatus），落在第 3 行。 */
  readonly statusText?: string;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  idle: "idle",
  streaming: "streaming",
  tool: "tool",
};

/** token 紧凑格式：<1000 原样；1k~10k 保留一位；10k+ 整数 k；M 同理。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
    return `${Math.round(value / 1000)}k`;
  }
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

/** 仅在路径位于 home 之内时折叠为 ~，避免误伤无关绝对路径。 */
export function foldHome(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(prefix) ? `~${path.slice(home.length)}` : path;
}

/** 左串按宽度截断，与右串之间保底保留 2 个空格间距。 */
export function truncateWithGap(left: string, right: string, width: number): string {
  const gap = 2;
  const room = width - gap - right.length;
  if (room <= 0) return `${" ".repeat(gap)}${right}`;
  const head = left.length > room ? left.slice(0, room) : left;
  return `${head}${" ".repeat(Math.max(gap, width - head.length - right.length))}${right}`;
}

/** 组装右对齐行，返回定宽字符串。 */
export function composeRow(left: string, right: string, width: number): string {
  return truncateWithGap(left, right, width);
}

/** >70% 黄、>90% 红，其余用 muted。 */
export function contextColorToken(percent: number): "muted" | "warning" | "error" {
  if (percent > 90) return "error";
  if (percent > 70) return "warning";
  return "muted";
}

/** 是否启用高保真三行布局：显式注入任意高保真字段时启用，否则保持单行兼容 T-02 视口。 */
function isHighFidelity(props: FooterViewProps): boolean {
  return [props.pwd, props.branch, props.session, props.metrics, props.provider, props.modelId, props.statusText].some(
    (value) => value !== undefined,
  );
}

export function FooterView(props: FooterViewProps) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const width = () => Math.max(20, dimensions().width);
  const hiFi = () => isHighFidelity(props);

  const statusLabel = () => STATUS_TEXT[props.status] ?? props.status;

  const leftMetrics = () => {
    const m = props.metrics;
    if (!m) return "";
    return [
      `↑${formatTokens(m.inputTokens)}`,
      `↓${formatTokens(m.outputTokens)}`,
      `R${formatTokens(m.cacheReadTokens)}`,
      `W${formatTokens(m.cacheWriteTokens)}`,
      `CH${m.cacheHitPercent}%`,
      `$${m.costUsd.toFixed(2)}`,
      `ctx ${props.budget.percent}%`,
    ].join(" ");
  };

  const rightMetrics = () => {
    const parts: string[] = [];
    if (props.provider) parts.push(props.provider);
    if (props.modelId) parts.push(props.modelId);
    const identity = parts.join("/");
    return props.thinking ? `${identity}${identity ? " " : ""}thinking` : identity;
  };

  const statusLine = () => {
    const retry = props.retry ? ` ${props.retry}` : "";
    const text = props.statusText ? ` ${props.statusText}` : "";
    return `${props.model} ${statusLabel()}${retry} ctx ${props.budget.percent}%${text}`;
  };

  if (!hiFi()) {
    return (
      <box flexDirection="row" height={1}>
        <text fg={theme.color("accent")}>{props.model}</text>
        <text> </text>
        <text fg={theme.color("info")}>{statusLabel()}</text>
        {props.retry ? <text fg={theme.color("warning")}> {props.retry}</text> : null}
        <text> </text>
        <text fg={theme.color("muted")}>{`ctx ${props.budget.percent}%`}</text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexShrink={0} height={3}>
      <text fg={theme.color("muted")}>
        {`${foldHome(props.pwd ?? "~", props.home ?? "")} (${props.branch ?? "-"}) ${props.session ?? props.model}`}
      </text>
      <text fg={theme.color(contextColorToken(props.budget.percent))}>
        {composeRow(leftMetrics(), rightMetrics(), width())}
      </text>
      <text fg={theme.color("accent")}>{statusLine()}</text>
    </box>
  );
}
