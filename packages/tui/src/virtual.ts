export interface VisibleWindow {
  readonly start: number;
  readonly end: number;
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: expected a non-negative integer`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label}: expected a finite number`);
}

export function visibleWindow(
  totalRows: number,
  viewportHeight: number,
  scrollTop: number
): VisibleWindow {
  assertCount(totalRows, "totalRows");
  assertCount(viewportHeight, "viewportHeight");
  assertFinite(scrollTop, "scrollTop");
  const start = Math.min(totalRows, Math.max(0, Math.floor(scrollTop)));
  return { start, end: Math.min(totalRows, start + viewportHeight) };
}

export function clampScroll(totalRows: number, viewportHeight: number, scrollTop: number): number {
  assertCount(totalRows, "totalRows");
  assertCount(viewportHeight, "viewportHeight");
  assertFinite(scrollTop, "scrollTop");
  const maxScroll = Math.max(0, totalRows - viewportHeight);
  return Math.min(maxScroll, Math.max(0, Math.floor(scrollTop)));
}
