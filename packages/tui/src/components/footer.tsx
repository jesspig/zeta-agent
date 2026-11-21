import type { ContextBudget } from "../hud";

export interface FooterViewProps {
  readonly model: string;
  readonly status: string;
  readonly budget: ContextBudget;
  readonly retry?: string;
}

export function FooterView(props: FooterViewProps) {
  return (
    <box flexDirection="row" height={1}>
      <text fg="#7ee787">{props.model}</text>
      <text> </text>
      <text fg="#58a6ff">{props.status}</text>
      <text> </text>
      <text fg={props.budget.level === "critical" ? "#ff7b72" : "#8b949e"}>
        {`${props.budget.percent}%`}
      </text>
    </box>
  );
}
