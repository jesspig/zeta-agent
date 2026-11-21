import { useTheme } from "../theme-context";

export interface ThinkingBlockProps {
  readonly text: string;
  readonly expanded: boolean;
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <text fg={theme.color("thinking")}>thinking</text>
      {props.expanded ? <text>{props.text}</text> : <text fg={theme.color("muted")}>[展开]</text>}
    </box>
  );
}
