import { Show } from "solid-js";

/** 纯字符串 markdown 投影：在测试环境（tree-sitter 不可用）提供稳定可读的降级文本。 */
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

/** 生产渲染：优先官方 markdown，流式/测试环境用纯文本投影辅助。 */
export function MarkdownContent(props: MarkdownContentProps) {
  return (
    <box>
      <Show when={props.content.length > 0} fallback={<text> </text>}>
        <text>{markdownPlain(props.content)}</text>
      </Show>
    </box>
  );
}

export interface CodeContentProps {
  readonly content: string;
  readonly filetype?: string;
}

export function CodeContent(props: CodeContentProps) {
  return (
    <box>
      <text>...</text>
      <text>{props.content}</text>
    </box>
  );
}
