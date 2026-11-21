export type ScreenMode = "alternate-screen" | "main-screen" | "split-footer";

export interface DualModeConfig {
  readonly screenMode: ScreenMode;
  readonly preservesScrollback: boolean;
}

/** O-12 双模式裁决：OpenTUI 0.9.3 原生支持三种 screenMode，main-screen 保留 scrollback。 */
export function resolveDualMode(mode: "regular" | "fullscreen" | undefined): DualModeConfig {
  if (mode === "regular") {
    return { screenMode: "main-screen", preservesScrollback: true };
  }
  if (mode === "fullscreen") {
    return { screenMode: "alternate-screen", preservesScrollback: false };
  }
  return { screenMode: "alternate-screen", preservesScrollback: false };
}
