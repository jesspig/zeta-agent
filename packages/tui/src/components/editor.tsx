import { createSignal, onCleanup, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { createHistory } from "../editor-history";
import { foldBracketedPaste, graphemeSafeTruncate, killRing, undoStack } from "../paste";

export interface EditorHandle {
  value(): string;
  setValue(value: string): void;
  onKey(key: KeyEvent): boolean;
}

/** 增强编辑器状态：历史上翻/下翻、kill-ring、undo、bracketed paste 折叠、CJK 安全截断。 */
export function createEditorState() {
  const history = createHistory(100);
  const ring = killRing();
  const undo = undoStack();
  const [value, setValue] = createSignal("");
  const [pasted, setPasted] = createSignal(0);

  function commit(next: string): void {
    setValue(next);
    undo.record(next);
  }

  function handlePaste(raw: string): void {
    const folded = foldBracketedPaste(raw);
    setPasted((count) => count + folded.blocks.length);
    commit(value() + folded.text);
  }

  function handleKey(key: KeyEvent): boolean {
    if (key.name === "up") {
      const previous = history.previous(value());
      if (previous !== null) commit(previous);
      return true;
    }
    if (key.name === "down") {
      const next = history.next();
      if (next !== null) commit(next);
      return true;
    }
    if ((key.ctrl || key.meta) && key.name === "k") {
      ring.kill(value());
      commit("");
      return true;
    }
    if ((key.ctrl || key.meta) && key.name === "y") {
      const yanked = ring.yankPop();
      if (yanked !== null) commit(value() + yanked);
      return true;
    }
    if ((key.ctrl || key.meta) && key.name === "z") {
      const previous = undo.undo();
      if (previous !== null) setValue(previous);
      return true;
    }
    return false;
  }

  function submit(): string {
    const text = value().trim();
    if (text.length > 0) history.push(text);
    commit("");
    return text;
  }

  return { value, setValue, commit, handleKey, handlePaste, submit, pasted, graphemeSafeTruncate };
}

export interface ZetaEditorProps {
  readonly onSubmit: (text: string) => void | Promise<void>;
  readonly placeholder?: string;
}

export function ZetaEditor(props: ZetaEditorProps) {
  const state = createEditorState();
  return (
    <textarea
      focused={true}
      placeholder={props.placeholder ?? "输入消息（Shift+Enter 换行，Enter 提交）"}
      initialValue={state.value()}
      onSubmit={() => {
        const text = state.submit();
        if (text.length > 0) void props.onSubmit(text);
      }}
    />
  );
}
