import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions, useTimeline } from "@opentui/solid";
import { createHistory } from "../editor-history";
import { foldBracketedPaste, graphemeSafeTruncate, killRing, undoStack } from "../paste";
import { useOsc } from "../osc-context";
import { useTheme } from "../theme-context";
import { SPINNER_FRAME_MS, SPINNER_FRAMES } from "./loader";

import {
  applySlashCommand,
  filterSlashCommands,
  slashCommandDescription,
  slashCommandLabel,
  slashQuery,
  type SlashCommand,
} from "../slash";

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
  readonly onSubmit: (text: string, mode?: SubmitMode) => void | Promise<void>;
  /** 区分 steer / follow-up 的提交入口；缺省时两种模式都回落到 onSubmit。 */
  readonly onSubmitWithMode?: (text: string, mode: SubmitMode) => void | Promise<void>;
  readonly placeholder?: string;
  /** 斜杠命令候选来源；缺省时不显示候选列表。 */
  readonly commands?: readonly SlashCommand[];
  /** 工作状态：在顶边框内显示 spinner 与标签。 */
  readonly status?: "idle" | "streaming" | "tool";
  /** 文本变化回调（用于外部感知是否为空等）。 */
  readonly onChange?: (text: string) => void;
  /** Esc 在候选关闭时的语义（中止当前运行）。 */
  readonly onEscape?: () => void;
  /** 供宿主读取/清空当前文本。 */
  readonly onHandle?: (handle: EditorHandle) => void;
}

const MAX_VISIBLE_COMMANDS = 5;

interface TextAreaLike {
  plainText: string;
  setText(text: string): void;
  insertText(text: string): void;
  focus(): void;
  gotoBufferEnd?(): void;
  logicalCursor: { readonly row: number; readonly col: number };
}

/** 编辑器顶边框：空闲时是一条横线；工作时内嵌 spinner 与状态文案。 */
function EditorBorder(props: { readonly status: "idle" | "streaming" | "tool"; readonly width: number }) {
  const theme = useTheme();
  const [frame, setFrame] = createSignal<string>(SPINNER_FRAMES[0]);
  const timeline = useTimeline({ duration: 800, loop: true, autoplay: true });
  onMount(() => {
    for (let index = 0; index < SPINNER_FRAMES.length; index += 1) {
      timeline.call(() => setFrame(SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]), index * SPINNER_FRAME_MS);
    }
  });
  createEffect(() => {
    if (props.status === "idle") timeline.pause();
    else timeline.play();
  });
  onCleanup(() => timeline.pause());

  const label = () => {
    if (props.status === "tool") return "Running tool";
    if (props.status === "streaming") return "Working";
    return "";
  };
  const prefix = () => (label().length > 0 ? `── ${frame()} ${label()} ` : "");
  const remainder = () => Math.max(0, props.width - prefix().length);
  return (
    <box height={1}>
      <Show when={label().length > 0} fallback={<text fg={theme.color("borderMuted")}>{"─".repeat(props.width)}</text>}>
        <text>
          <span style={{ fg: theme.color("borderMuted") }}>{"── "}</span>
          <span style={{ fg: theme.color("spinner") }}>{`${frame()} ${label()}`}</span>
          <span style={{ fg: theme.color("borderMuted") }}>{` ${"─".repeat(Math.max(0, remainder() - 1))}`}</span>
        </text>
      </Show>
    </box>
  );
}

/**
 * 生产编辑器：Textarea 承载文本与光标，外部状态承载历史/kill-ring/paste。
 * 斜杠命令候选在底边框之下展开（与目标终端 UI 一致），↑/↓ 选择、Tab/Enter 应用、Esc 关闭。
 */
export function ZetaEditor(props: ZetaEditorProps) {
  const theme = useTheme();
  const osc = useOsc();
  const dimensions = useTerminalDimensions();
  const width = createMemo(() => Math.max(20, dimensions().width));
  // 生产编辑器复用已实现的状态机：历史、follow-up 队列、abort 退回均由同一实例持有。
  const editorState = createEditorState();
  const history = editorState.history;
  const ring = killRing();
  const undo = undoStack();
  let area: TextAreaLike | null = null;
  const [text, setText] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const commands = createMemo<readonly SlashCommand[]>(() => props.commands ?? []);
  const query = createMemo(() => slashQuery(text()));
  const filtered = createMemo<readonly SlashCommand[]>(() => {
    const current = query();
    if (current === null || commands().length === 0) return [];
    return filterSlashCommands(commands(), current.prefix);
  });

  const syncText = (next: string): void => {
    setText(next);
    props.onChange?.(next);
    const current = slashQuery(next);
    if (current === null || commands().length === 0) {
      setMenuOpen(false);
      setSelected(0);
      return;
    }
    const items = filterSlashCommands(commands(), current.prefix);
    setMenuOpen(items.length > 0);
    setSelected(0);
  };

  const setAreaText = (next: string): void => {
    if (area !== null) {
      area.setText(next);
      // setText 会把光标重置到开头；补全/历史回填后必须回到末尾。
      area.gotoBufferEnd?.();
      area.focus();
    }
    syncText(next);
  };

  const insert = (next: string): void => {
    if (area !== null) {
      area.insertText(next);
      area.focus();
      syncText(area.plainText);
    } else {
      setAreaText(next);
    }
  };

  const submitWithMode = (mode: SubmitMode, overrideText?: string): void => {
    const value = (overrideText ?? area?.plainText ?? text()).trim();
    if (value.length === 0) return;
    // 让状态机持有当前文本，submitWithMode 据此入队（follow-up）或记账（steer）。
    editorState.setValue(value);
    editorState.submitWithMode(mode);
    if (props.onSubmitWithMode !== undefined) void props.onSubmitWithMode(value, mode);
    else void props.onSubmit?.(value);
    setAreaText("");
  };

  const submit = (): void => submitWithMode("steer");

  const applySelected = (submitAfter: boolean): boolean => {
    const items = filtered();
    const item = items[selected()];
    if (item === undefined) return false;
    if (submitAfter) {
      submitWithMode("steer", `/${item.name}`);
    } else {
      setAreaText(applySlashCommand(item));
    }
    setMenuOpen(false);
    return true;
  };

  props.onHandle?.({
    value: () => area?.plainText ?? text(),
    setValue: (value) => setAreaText(value),
    onKey: () => false,
  });
  onMount(() => {
    area?.focus();
  });

  useKeyboard((key) => {
    if (key.eventType === "release") return;

    // 候选列表打开时优先处理导航与确认。
    if (menuOpen()) {
      if (key.name === "up") {
        key.preventDefault();
        key.stopPropagation();
        setSelected((index) => {
          const size = filtered().length;
          if (size === 0) return 0;
          return (index - 1 + size) % size;
        });
        return;
      }
      if (key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        setSelected((index) => {
          const size = filtered().length;
          if (size === 0) return 0;
          return (index + 1) % size;
        });
        return;
      }
      if (key.name === "tab") {
        key.preventDefault();
        key.stopPropagation();
        applySelected(false);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        if (applySelected(true)) return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        setMenuOpen(false);
        return;
      }
    }

    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      // abort 时 follow-up 队列整队退回编辑器，不丢失排队输入。
      editorState.setValue(area?.plainText ?? text());
      const restored = editorState.abort();
      if (restored !== (area?.plainText ?? text())) setAreaText(restored);
      props.onEscape?.();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const mode = resolveSubmitMode(key);
      // Shift+Enter 保留为换行；Alt/Option+Enter 走 follow-up 队列。
      if (mode === null) return;
      key.preventDefault();
      key.stopPropagation();
      submitWithMode(mode);
      return;
    }

    if (key.name === "up" && (key.meta || key.option)) {
      key.preventDefault();
      key.stopPropagation();
      editorState.setValue(area?.plainText ?? "");
      if (editorState.handleKey(key)) setAreaText(editorState.value());
      return;
    }

    if (key.name === "up") {
      const row = area?.logicalCursor.row ?? 0;
      if (row === 0 && (area?.plainText.length ?? 0) > 0) {
        const previous = history.previous(area?.plainText ?? "");
        if (previous !== null) {
          key.preventDefault();
          key.stopPropagation();
          setAreaText(previous);
        }
      }
      return;
    }

    if (key.name === "down") {
      const value = area?.plainText ?? "";
      const rows = value.split("\n").length;
      if ((area?.logicalCursor.row ?? 0) >= rows - 1) {
        const next = history.next();
        if (next !== null) {
          key.preventDefault();
          key.stopPropagation();
          setAreaText(next);
        }
      }
      return;
    }

    if (key.ctrl && key.shift && key.name.toLowerCase() === "c") {
      // 选择即复制：把当前输入/选区写入系统剪贴板（OSC 52）。
      key.preventDefault();
      key.stopPropagation();
      const selected = area?.plainText ?? text();
      if (selected.length > 0) osc.copySelection(selected);
      return;
    }

    if (key.ctrl && key.name === "c") {
      // 与目标终端 UI 一致：Ctrl+C 清空编辑器（退出用 Ctrl+D）。
      key.preventDefault();
      key.stopPropagation();
      setAreaText("");
      return;
    }

    if (key.ctrl && key.name === "k") {
      key.preventDefault();
      key.stopPropagation();
      ring.kill(area?.plainText ?? "");
      setAreaText("");
      return;
    }

    if (key.ctrl && key.name === "y") {
      const yanked = ring.yankPop();
      if (yanked !== null) {
        key.preventDefault();
        key.stopPropagation();
        insert(yanked);
      }
      return;
    }

    if (key.ctrl && key.name === "z") {
      const previous = undo.undo();
      if (previous !== null) {
        key.preventDefault();
        key.stopPropagation();
        setAreaText(previous);
      }
    }
  });

  const decoder = new TextDecoder();
  usePaste((event) => {
    const raw = decoder.decode(event.bytes);
    if (raw.length === 0) return;
    const folded = foldBracketedPaste(raw);
    event.preventDefault();
    insert(folded.text);
  });

  const commandRow = (item: SlashCommand, index: number) => {
    const primary = slashCommandLabel(item);
    const description = slashCommandDescription(item);
    const isSelected = index === selected();
    const prefix = isSelected ? "→ " : "  ";
    if (description === undefined || width() <= 40) {
      return { prefix, primary, spacing: "", description: "" };
    }
    const primaryWidth = 32;
    const truncatedPrimary = graphemeSafeTruncate(primary, primaryWidth - 2);
    const available = Math.max(1, width() - prefix.length - primaryWidth - 2);
    return {
      prefix,
      primary: truncatedPrimary,
      spacing: " ".repeat(Math.max(1, primaryWidth - truncatedPrimary.length)),
      description: graphemeSafeTruncate(description, available),
    };
  };

  const visibleCommands = createMemo(() => {
    const items = filtered();
    if (items.length <= MAX_VISIBLE_COMMANDS) {
      return { items, offset: 0 };
    }
    const offset = Math.max(0, Math.min(selected() - Math.floor(MAX_VISIBLE_COMMANDS / 2), items.length - MAX_VISIBLE_COMMANDS));
    return { items: items.slice(offset, offset + MAX_VISIBLE_COMMANDS), offset };
  });

  return (
    <box flexDirection="column" flexShrink={0}>
      <EditorBorder status={props.status ?? "idle"} width={width()} />
      <box>
        <textarea
          ref={(element) => {
            area = element as unknown as TextAreaLike;
          }}
          focused={true}
          width="100%"
          placeholder={props.placeholder ?? "输入消息，/ 查看命令"}
          textColor={theme.color("text")}
          placeholderColor={theme.color("dim")}
          cursorColor={theme.color("accent")}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          keyBindings={[{ name: "return", action: "submit" }]}
          onSubmit={() => {
            submit();
          }}
          onContentChange={() => {
            syncText(area?.plainText ?? "");
          }}
        />
      </box>
      <box height={1}>
        <text fg={theme.color("borderMuted")}>{"─".repeat(width())}</text>
      </box>
      <Show when={menuOpen() && filtered().length > 0}>
        <box flexDirection="column">
          <For each={visibleCommands().items}>
            {(item, index) => {
              const actual = () => index() + visibleCommands().offset;
              const row = () => commandRow(item, actual());
              const selectedRow = () => actual() === selected();
              return (
                <text>
                  <span style={{ fg: selectedRow() ? theme.color("accent") : undefined }}>
                    {`${row().prefix}${row().primary}`}
                  </span>
                  <span style={{ fg: theme.color(selectedRow() ? "accent" : "muted") }}>
                    {`${row().spacing}${row().description}`}
                  </span>
                </text>
              );
            }}
          </For>
          <Show when={filtered().length > MAX_VISIBLE_COMMANDS}>
            <text fg={theme.color("muted")}>
              {`  (${selected() + 1}/${filtered().length})`}
            </text>
          </Show>
        </box>
      </Show>
    </box>
  );
}
