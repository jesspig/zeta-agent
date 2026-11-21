export interface History {
  readonly size: number;
  push(entry: string): void;
  previous(draft?: string): string | null;
  next(): string | null;
  entries(): readonly string[];
  currentDraft(): string | null;
}

/** IF-10 历史+草稿：容量上限、相邻重复折叠、当前草稿暂存与恢复。 */
export function createHistory(limit = 100): History {
  const entries: string[] = [];
  let cursor = -1;
  let draft: string | null = null;
  let navigated = false;

  function push(entry: string): void {
    if (typeof entry !== "string") throw new Error("HISTORY_ENTRY_INVALID");
    if (entries.at(-1) === entry) {
      cursor = entries.length - 1;
      draft = null;
      navigated = false;
      return;
    }
    entries.push(entry);
    while (entries.length > limit) entries.shift();
    cursor = entries.length - 1;
    draft = null;
    navigated = false;
  }

  function previous(currentDraft?: string): string | null {
    if (!navigated && currentDraft !== undefined) draft = currentDraft;
    if (entries.length === 0) return null;
    if (navigated && cursor > 0) cursor -= 1;
    else cursor = entries.length - 1;
    navigated = true;
    return entries[cursor] ?? null;
  }

  function next(): string | null {
    if (!navigated) return null;
    if (cursor >= entries.length - 1) {
      cursor = entries.length;
      draft = null;
      navigated = false;
      return null;
    }
    cursor += 1;
    return entries[cursor] ?? null;
  }

  return {
    get size() {
      return entries.length;
    },
    push,
    previous,
    next,
    entries: () => [...entries],
    currentDraft: () => draft,
  };
}
