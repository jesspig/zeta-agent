import { For, createSignal } from "solid-js";
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
  readonly palette: CommandPalette;
  readonly query: string;
}

export function CommandPaletteView(props: CommandPaletteViewProps) {
  return (
    <box flexDirection="column" border={true} title="命令面板">
      <For each={props.palette.filter(props.query)}>
        {(command) => <text>{`${command.id}: ${command.title}`}</text>}
      </For>
    </box>
  );
}
