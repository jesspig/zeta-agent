export interface FrameState {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
  readonly hud?: string;
}
