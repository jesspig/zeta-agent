export type DiffOp = "add" | "remove" | "context";

export interface WordDiff {
  readonly kind: "replace" | "same";
  readonly before?: string;
  readonly after?: string;
}

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
  readonly wordDiff?: WordDiff;
}

function splitWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [];
}

function firstDifference(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return length;
}

function wordDiff(before: string, after: string): WordDiff | undefined {
  if (before === after) return undefined;
  const at = firstDifference(before, after);
  return {
    kind: "replace",
    before: before.slice(Math.max(0, at - 2), at + 4),
    after: after.slice(Math.max(0, at - 2), at + 4),
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
  const lines = () => diffLines(props.before, props.after);
  return (
    <box flexDirection="column">
      {lines().map((line) => (
        <text fg={DIFF_COLORS[line.op]}>
          {`${line.op === "add" ? "+" : line.op === "remove" ? "-" : " "} ${line.text}`}
        </text>
      ))}
      {lines().some((line) => line.wordDiff?.kind === "replace") ? (
        <text fg="#d2a8ff">[diff]</text>
      ) : null}
    </box>
  );
}

export { splitWords };
