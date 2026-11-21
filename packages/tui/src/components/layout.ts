export function clampWidth(desired: number, available: number): number {
  return Math.max(1, Math.min(desired, available));
}

export function clampHeight(desired: number, available: number): number {
  return Math.max(1, Math.min(desired, available));
}
