export interface FrameState {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
  readonly hud?: string;
}

function border(width: number): string {
  return `+${"-".repeat(width - 2)}+`;
}

function contentRow(text: string, width: number): string {
  const inner = text.length > width - 2 ? text.slice(0, width - 2) : text.padEnd(width - 2, " ");
  return `|${inner}|`;
}

export function testRender(state: FrameState): string {
  if (!Number.isInteger(state.width) || state.width < 2) {
    throw new Error("width: expected an integer greater than one");
  }
  if (!Number.isInteger(state.height) || state.height < 2) {
    throw new Error("height: expected an integer greater than one");
  }

  const body = [...state.lines];
  if (state.hud !== undefined) body.push(state.hud);
  const rows = [border(state.width)];
  for (let index = 0; index < state.height - 2; index += 1) {
    rows.push(contentRow(body[index] ?? "", state.width));
  }
  rows.push(border(state.width));
  return rows.join("\n");
}
