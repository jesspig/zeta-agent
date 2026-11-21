import { Show } from "solid-js";
import { useTheme } from "../theme-context";

/** 稳定 markdown 投影：标题/粗体/行内代码做可读降级，无 tree-sitter 依赖。 */
export function markdownPlain(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, ""))
    .map((line) => line.replace(/\*\*([^*]+)\*\*/g, "$1"))
    .map((line) => line.replace(/`([^`]+)`/g, "$1"))
    .join("\n");
}

export interface MarkdownContentProps {
  readonly content: string;
  readonly width?: number | string;
}

/**
 * Markdown 正文：用稳定投影渲染（流式安全）。
 * 围栏代码块走 CodeContent；CodeContent 在语法高亮不可用时降级纯文本。
 */
export function MarkdownContent(props: MarkdownContentProps) {
  const segments = () => props.content.split(/```/);
  return (
    <box flexDirection="column">
      <Show when={props.content.length > 0} fallback={<text> </text>}>
        {segments().map((segment, index) =>
          index % 2 === 1 ? (
            <CodeContent
              content={segment.replace(/^[a-zA-Z0-9+#_-]+\n/, "")}
              filetype={segment.match(/^([a-zA-Z0-9+#_-]+)\n/)?.[1]}
            />
          ) : (
            <Show when={segment.trim().length > 0}>
              <text>{markdownPlain(segment)}</text>
            </Show>
          ),
        )}
      </Show>
    </box>
  );
}

export interface CodeContentProps {
  readonly content: string;
  readonly filetype?: string;
}

/** 代码块渲染：带语言标签的稳定文本投影（高亮能力由宿主渲染器决定）。 */
export function CodeContent(props: CodeContentProps) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <Show when={props.filetype}>
        <text fg={theme.color("thinking")}>{`[${props.filetype}]`}</text>
      </Show>
      <text>{props.content.trimEnd()}</text>
    </box>
  );
}
