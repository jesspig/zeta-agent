import type { JSX } from "@opentui/solid";

export interface ViewportLayoutProps {
  /** 上方可滚对话区：消息列表或回退帧。 */
  readonly transcript: JSX.Element;
  /** 下方固定停靠区：工作指示器 + 编辑器 + footer。 */
  readonly dock: JSX.Element;
}

/**
 * T-02 视口两层布局：根容器占满终端；transcript 用 flexGrow=1 吃掉剩余高度并可滚，
 * dock 用 flexShrink=0 固定在下方，不随消息增长被挤出屏幕。
 */
export function ViewportLayout(props: ViewportLayoutProps) {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1}>
        {props.transcript}
      </box>
      <box flexDirection="column" flexShrink={0}>
        {props.dock}
      </box>
    </box>
  );
}
