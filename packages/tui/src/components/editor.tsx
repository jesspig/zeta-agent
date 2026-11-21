import { createSignal, onCleanup } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/solid";
import { createHistory } from "../editor-history";
import { foldBracketedPaste, graphemeSafeTruncate, killRing, undoStack } from "../paste";

export interface EditorHandle {
  value(): string;
  setValue(value: string): void;
  onKey(key: KeyEvent): boolean;
}

/** T-08 提交语义：Enter=steer（当前轮），Alt/Option+Enter=follow-up（下一轮排队）。 */
export type SubmitMode = "steer" | "follow-up";

export function resolveSubmitMode(
  key: Pick<KeyEvent, "name"> & Partial<Pick<KeyEvent, "meta" | "option">>,
): SubmitMode | null {
  if (key.name !== "return" && key.name !== "enter") return null;
  return key.meta || key.option ? "follow-up" : "steer";
}

export interface FollowUpEntry {
  readonly id: number;
  readonly text: string;
}

export function enqueueFollowUp(text: string, id: number): FollowUpEntry {
  return { id, text };
}

export interface FollowUpQueue {
  enqueue(text: string): void;
  take(): string | undefined;
  size(): number;
  entries(): readonly string[];
}

/** FIFO follow-up 队列：Alt+Up 取回最早一条，abort 时整队退回编辑器。 */
export function createFollowUpQueue(): FollowUpQueue {
  const items: string[] = [];
  return {
    enqueue(text) { items.push(text); },
    take() { return items.shift(); },
    size() { return items.length; },
    entries() { return [...items]; },
  };
}

/** abort 时把队列内容按序取回（供编辑器回填）。 */
export function drainQueue(queue: FollowUpQueue): string[] {
  const drained: string[] = [];
  for (;;) {
    const next = queue.take();
    if (next === undefined) break;
    drained.push(next);
  }
  return drained;
}

/** 增强编辑器状态：历史上下翻、kill-ring、undo、bracketed paste 折叠、CJK 安全截断。 */
export function createEditorState() {
  const history = createHistory(100);
  const ring = killRing();
  const undo = undoStack();
  const followUps = createFollowUpQueue();
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
    // T-08：Alt+Up 从 follow-up 队列取回最早一条到编辑器。
    if (key.name === "up" && (key.meta || key.option)) {
      const next = followUps.take();
      if (next !== undefined) {
        commit(value().length > 0 ? `${value()} ${next}` : next);
        return true;
      }
    }
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

  /** 按提交模式处理当前输入：steer 直接返回文本；follow-up 入队并返回空串。 */
  function submitWithMode(mode: SubmitMode): string {
    const text = value().trim();
    if (text.length === 0) return "";
    if (mode === "follow-up") {
      followUps.enqueue(text);
      commit("");
      return "";
    }
    return submit();
  }

  /** abort：把 follow-up 队列内容以换行拼接退回编辑器。 */
  function abort(): string {
    const drained = drainQueue(followUps);
    if (drained.length === 0) return value();
    const restored = [...drained, value()].filter((part) => part.length > 0).join("\n");
    commit(restored);
    return restored;
  }

  return {
    value, setValue, commit, handleKey, handlePaste, submit, submitWithMode, abort,
    followUps, pasted, graphemeSafeTruncate, history,
  };
}

export interface ZetaEditorProps {
  readonly onSubmit: (text: string) => void | Promise<void>;
  readonly placeholder?: string;
}

/**
 * 生产编辑器：Textarea 承载文本与光标，createEditorState 承载历史/kill-ring/undo/paste。
 * 二者以 useKeyboard/usePaste 接线，state 消费的按键跳过 Textarea 内置处理，避免双源写冲突。
 */
export function ZetaEditor(props: ZetaEditorProps) {
  const state = createEditorState();
  let area: {
    plainText: string;
    setText(text: string): void;
    insertText(text: string): void;
    focus(): void;
  } | null = null;

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const consumed = state.handleKey(key);
    if (!consumed) return;
    key.preventDefault();
    key.stopPropagation();
    if (area !== null) {
      area.setText(state.value());
      area.focus();
    }
  });

  const textDecoder = new TextDecoder();
  usePaste((event) => {
    const raw = textDecoder.decode(event.bytes);
    if (raw.length === 0) return;
    event.preventDefault();
    state.handlePaste(raw);
    if (area !== null) {
      area.setText(state.value());
      area.focus();
    }
  });

  return (
    <textarea
      ref={(el) => { area = el; }}
      focused={true}
      placeholder={props.placeholder ?? "输入消息（Shift+Enter 换行，Enter 提交）"}
      initialValue={state.value()}
      keyBindings={[{ name: "return", action: "submit" }]}
      onSubmit={() => {
        const text = area !== null ? area.plainText.trim() : state.submit().trim();
        if (text.length > 0) {
          state.history.push(text);
          void props.onSubmit(text);
        }
        state.commit("");
        if (area !== null) {
          area.setText("");
          area.focus();
        }
      }}
    />
  );
}
