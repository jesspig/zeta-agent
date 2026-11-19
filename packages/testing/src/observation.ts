export function observeState(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(observeState).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${observeState(record[key])}`).join(",")}}`;
}

export function sameObservation(left: unknown, right: unknown): boolean {
  return observeState(left) === observeState(right);
}
