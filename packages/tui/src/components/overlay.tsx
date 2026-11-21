import { useTheme } from "../theme-context";

export interface ConfirmOverlayProps {
  readonly message: string;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

/** 轻量确认 overlay（测试环境用 box 投影，生产可经 Portal mount 到 renderer.root）。 */
export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const theme = useTheme();
  return (
    <box border={true} title="确认">
      <text>{props.message}</text>
      <text fg={theme.color("muted")}>[Enter] 确认  [Esc] 取消</text>
    </box>
  );
}
