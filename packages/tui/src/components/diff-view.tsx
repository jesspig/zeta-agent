import { useTheme } from "../theme-context";

export type DiffOp = "add" | "remove" | "context";

export interface WordDiff {
  readonly kind: "replace" | "same";
  readonly before?: string;
  readonly after?: string;
  /** 词级 LCS 结果：被删除/新增的词序列，供逐词反显渲染。 */
  readonly removedWords?: readonly string[];
  readonly addedWords?: readonly string[];
}

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
  readonly wordDiff?: WordDiff;
}

function splitWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [];
}

/** 真正的词级 LCS：返回未匹配（删除/新增）的词序列，支持插入、删除与多词重排。 */
export function diffWords(before: string, after: string): {
  readonly removedWords: readonly string[];
  readonly addedWords: readonly string[];
} {
  const a = splitWords(before).filter((token) => token.trim().length > 0);
  const b = splitWords(after).filter((token) => token.trim().length > 0);
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const removedWords: string[] = [];
  const addedWords: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      addedWords.push(b[j]!);
      j += 1;
    } else {
      removedWords.push(a[i]!);
      i += 1;
    }
  }
  return { removedWords, addedWords };
}

function wordDiff(before: string, after: string): WordDiff | undefined {
  if (before === after) return undefined;
  const { removedWords, addedWords } = diffWords(before, after);
  return {
    kind: "replace",
    before,
    after,
    removedWords,
    addedWords,
  };
}

/** 基于行的 LCS 差分；同位置改写行附带词级反显标记。 */
export function diffLines(beforeText: string, afterText: string): readonly DiffLine[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const value = before[i] === after[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
      table[i]![j] = value;
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ op: "context", text: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if (j < after.length && (i >= before.length || at(i, j + 1) >= at(i + 1, j))) {
      const removed = i < before.length ? before[i] : undefined;
      const addedText = after[j] ?? "";
      result.push({ op: "add", text: addedText, wordDiff: removed ? wordDiff(removed, addedText) : undefined });
      j += 1;
    } else {
      const added = j < after.length ? after[j] : undefined;
      const removedText = before[i] ?? "";
      result.push({ op: "remove", text: removedText, wordDiff: added ? wordDiff(removedText, added) : undefined });
      i += 1;
    }
  }
  return result;
}

const DIFF_COLORS = {
  add: "#7ee787",
  remove: "#ff7b72",
  context: "#8b949e",
} as const;

export function DiffView(props: { readonly before: string; readonly after: string }) {
  const theme = useTheme();
  const lines = () => diffLines(props.before, props.after);
  return (
    <box flexDirection="column">
      {lines().map((line) => (
        <text fg={DIFF_COLORS[line.op]}>
          {`${line.op === "add" ? "+" : line.op === "remove" ? "-" : " "} ${line.text}`}
        </text>
      ))}
      {lines().some((line) => line.wordDiff?.kind === "replace") ? (
        <text fg={theme.color("thinking")}>[diff]</text>
      ) : null}
    </box>
  );
}

export { splitWords };
