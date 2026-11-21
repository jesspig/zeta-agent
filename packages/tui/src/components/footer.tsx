import { Show } from "solid-js";
import type { ContextBudget } from "../hud";

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
  return (
    <box flexDirection="row" height={1}>
      <text fg="#7ee787">{props.model}</text>
      <text> </text>
      <text fg="#58a6ff">{STATUS_TEXT[props.status] ?? props.status}</text>
      <Show when={props.retry}>
        <text fg="#d29922"> {props.retry}</text>
      </Show>
      <text> </text>
      <text fg={props.budget.level === "critical" ? "#ff7b72" : "#8b949e"}>
        {`ctx ${props.budget.percent}%`}
      </text>
    </box>
  );
}
