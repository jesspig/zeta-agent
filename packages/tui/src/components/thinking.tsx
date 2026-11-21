export interface ThinkingBlockProps {
  readonly text: string;
  readonly expanded: boolean;
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  return (
    <box flexDirection="column">
      <text fg="#d2a8ff">thinking</text>
      {props.expanded ? <text>{props.text}</text> : <text fg="#8b949e">[展开]</text>}
    </box>
  );
}
