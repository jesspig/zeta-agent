import { For, createMemo, createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { fuzzyScore } from "./completion";

export interface Command {
  readonly id: string;
  readonly title: string;
}

export interface CommandPalette {
  filter(query: string): readonly Command[];
  select(id: string): Command | undefined;
  selected(): Command | undefined;
}

export function createCommandPalette(commands: readonly Command[]): CommandPalette {
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined);
  return {
    filter(query) {
      if (query.length === 0) return [...commands];
      return [...commands]
        .filter((command) => fuzzyScore(query, command.title) >= 0 || fuzzyScore(query, command.id) >= 0)
        .sort((a, b) => Math.max(fuzzyScore(query, b.title), fuzzyScore(query, b.id)) - Math.max(fuzzyScore(query, a.title), fuzzyScore(query, a.id)));
    },
    select(id) {
      const found = commands.find((command) => command.id === id);
      if (found) setSelectedId(id);
      return found;
    },
    selected() {
      const id = selectedId();
      return id === undefined ? undefined : commands.find((command) => command.id === id);
    },
  };
}

export interface CommandPaletteViewProps {
  readonly commands: readonly Command[];
  readonly onRun: (command: Command) => void;
  readonly onCancel: () => void;
}

/** 可交互命令面板：↑↓ 导航、Enter 执行、Esc 取消、普通字符增量搜索。 */
export function CommandPaletteView(props: CommandPaletteViewProps) {
  const palette = createCommandPalette(props.commands);
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const results = createMemo(() => palette.filter(query()));

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "up") {
      key.preventDefault();
      key.stopPropagation();
      setCursor((value) => Math.max(0, value - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      key.stopPropagation();
      setCursor((value) => Math.min(Math.max(0, results().length - 1), value + 1));
    } else if (key.name === "return") {
      key.preventDefault();
      key.stopPropagation();
      const command = results()[cursor()];
      if (command !== undefined) props.onRun(command);
    } else if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      props.onCancel();
    } else if (key.name === "backspace") {
      key.preventDefault();
      key.stopPropagation();
      setQuery((value) => value.slice(0, -1));
      setCursor(0);
    } else if (key.name.length === 1 && !key.ctrl && !key.meta) {
      key.preventDefault();
      key.stopPropagation();
      setQuery((value) => value + key.name);
      setCursor(0);
    }
  });

  return (
    <box flexDirection="column" border={true} title="命令面板">
      <text fg="#d29922">{`> ${query()}`}</text>
      <For each={results()}>
        {(command, index) => (
          <text fg={index() === cursor() ? "#7ee787" : "#c9d1d9"}>
            {`${index() === cursor() ? "> " : "  "}${command.id}: ${command.title}`}
          </text>
        )}
      </For>
    </box>
  );
}
