import { createSignal, onMount } from "solid-js";
import { useTimeline } from "@opentui/solid";
import { useTheme } from "../theme-context";

/** T-08 braille spinner：10 帧，每 80ms 推进一帧。 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const SPINNER_FRAME_MS = 80;
const CYCLE_MS = SPINNER_FRAMES.length * SPINNER_FRAME_MS;

/** 纯函数：给定经过毫秒数返回 spinner 帧，便于测试且不依赖渲染器时钟。 */
export function spinnerAtMs(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/** 倒计时格式：m:ss，负值归零。 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface LoaderProps {
  readonly label?: string;
}

/** Loader：useTimeline 驱动 80ms 步进的 spinner，挂载即播放、卸载由 hook 清理。 */
export function Loader(props: LoaderProps) {
  const theme = useTheme();
  const [frame, setFrame] = createSignal<string>(SPINNER_FRAMES[0]);

  const timeline = useTimeline({
    duration: CYCLE_MS,
    loop: true,
    autoplay: true,
  });
  onMount(() => {
    for (let i = 0; i < SPINNER_FRAMES.length; i += 1) {
      timeline.call(() => setFrame(SPINNER_FRAMES[i] ?? SPINNER_FRAMES[0]), i * SPINNER_FRAME_MS);
    }
  });

  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.color("spinner")}>{frame()}</text>
      {props.label ? <text fg={theme.color("muted")}> {props.label}</text> : null}
    </box>
  );
}

export interface CountdownTimerProps {
  readonly remainingMs: number;
}

/** CountdownTimer：展示格式化剩余时间；传入值由调用方按秒更新。 */
export function CountdownTimer(props: CountdownTimerProps) {
  const theme = useTheme();
  return (
    <box height={1}>
      <text fg={theme.color("warning")}>{formatCountdown(props.remainingMs)}</text>
    </box>
  );
}
