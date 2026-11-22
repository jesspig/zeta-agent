export function observeState(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(observeState).join(",")}]`;
  }
  if (value instanceof Map) {
    // Map 内容不进入 Object.keys；显式按条目序列化，键也用 observeState 保证稳定。
    const entries = [...value.entries()]
      .map(([k, v]) => `${observeState(k)}=>${observeState(v)}`)
      .sort();
    return `Map{${entries.join(",")}}`;
  }
  if (value instanceof Set) {
    const items = [...value.values()].map(observeState).sort();
    return `Set{${items.join(",")}}`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${observeState(record[key])}`).join(",")}}`;
}

export function sameObservation(left: unknown, right: unknown): boolean {
  return observeState(left) === observeState(right);
}
