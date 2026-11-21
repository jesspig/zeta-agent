import { Show } from "solid-js";
import type { ContextBudget } from "../hud";
import { useTheme } from "../theme-context";

export interface FooterViewProps {
  readonly model: string;
  readonly status: string;
  readonly budget: ContextBudget;
  readonly retry?: string;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  idle: "idle",
  streaming: "streaming",
  tool: "tool",
};

export function FooterView(props: FooterViewProps) {
  const theme = useTheme();
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.color("accent")}>{props.model}</text>
      <text> </text>
      <text fg={theme.color("info")}>{STATUS_TEXT[props.status] ?? props.status}</text>
      <Show when={props.retry}>
        <text fg={theme.color("warning")}> {props.retry}</text>
      </Show>
      <text> </text>
      <text fg={props.budget.level === "critical" ? theme.color("error") : theme.color("muted")}>
        {`ctx ${props.budget.percent}%`}
      </text>
    </box>
  );
}
