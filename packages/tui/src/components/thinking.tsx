import { createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useTheme } from "../theme-context";

export interface ThinkingBlockProps {
  readonly text: string;
  readonly expanded: boolean;
}

/**
 * Thinking 块：默认折叠为摘要行，Ctrl+T（pi 语义）切换展开/折叠全文。
 * expanded prop 作为初值；此后由内部状态管理，使交互闭环。
 */
export function ThinkingBlock(props: ThinkingBlockProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = createSignal(props.expanded);
  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "t") {
      key.preventDefault();
      key.stopPropagation();
      setExpanded((value) => !value);
    }
  });
  return (
    <box flexDirection="column">
      <text fg={theme.color("thinking")}>
        {expanded() ? "thinking (展开)" : "thinking"}
      </text>
      {expanded() ? <text>{props.text}</text> : <text fg={theme.color("muted")}>[Ctrl+T 展开]</text>}
    </box>
  );
}
