/** 按 Unicode 扩展字素簇切分，避免 CJK/emoji 组合被从中间切断。 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return [...GRAPHEME_SEGMENTER.segment(text)].map((segment) => segment.segment);
}

export function graphemeSafeTruncate(text: string, maxGraphemes: number): string {
  const parts = graphemes(text);
  return parts.slice(0, Math.max(0, maxGraphemes)).join("");
}

export interface KillRing {
  kill(text: string): void;
  yank(): string | null;
  yankPop(): string | null;
}

export function killRing(): KillRing {
  const entries: string[] = [];
  let index = -1;
  let lastYank = false;

  return {
    kill(text) {
      if (text.length === 0) return;
      entries.push(text);
      index = entries.length - 1;
      lastYank = false;
    },
    yank() {
      if (entries.length === 0) return null;
      index = entries.length - 1;
      lastYank = true;
      return entries[index] ?? null;
    },
    yankPop() {
      if (entries.length === 0) return null;
      if (!lastYank) return this.yank();
      if (index > 0) index -= 1;
      return entries[index] ?? null;
    },
  };
}

export interface UndoStack {
  record(value: string): void;
  undo(): string | null;
  redo(): string | null;
}

export function undoStack(): UndoStack {
  const states: string[] = [];
  let cursor = -1;

  return {
    record(value) {
      if (states[cursor] === value) return;
      states.splice(cursor + 1);
      states.push(value);
      cursor = states.length - 1;
    },
    undo() {
      if (cursor <= 0) return null;
      cursor -= 1;
      return states[cursor] ?? null;
    },
    redo() {
      if (cursor >= states.length - 1) return null;
      cursor += 1;
      return states[cursor] ?? null;
    },
  };
}

/** 大段粘贴折叠文案。 */
export function formatPasteBlock(id: number, extraLines: number): string {
  return `[paste #${id} +${extraLines} lines]`;
}

/** >10 行折叠为 [paste #N +X lines]，<=10 行原样保留。 */
export function foldLargePaste(text: string, id: number): string {
  const lines = text.split("\n");
  if (lines.length <= 10) return text;
  return formatPasteBlock(id, lines.length - 10);
}

export interface FoldedPaste {
  readonly text: string;
  readonly blocks: readonly { readonly id: number; readonly content: string }[];
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** bracketed paste 折叠为 `[paste #N]` 原子块，保留粘贴原文供展开。 */
export function foldBracketedPaste(input: string): FoldedPaste {
  const blocks: { id: number; content: string }[] = [];
  let text = input;
  let id = 0;
  let start = text.indexOf(PASTE_START);
  while (start !== -1) {
    const end = text.indexOf(PASTE_END, start + PASTE_START.length);
    if (end === -1) break;
    const content = text.slice(start + PASTE_START.length, end);
    id += 1;
    blocks.push({ id, content });
    text = text.slice(0, start) + `[paste #${id}]` + text.slice(end + PASTE_END.length);
    start = text.indexOf(PASTE_START, start + `[paste #${id}]`.length);
  }
  return { text, blocks };
}
