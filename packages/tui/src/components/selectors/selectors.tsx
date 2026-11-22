import { createMemo, createSignal, For } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createKeymap } from "../../keymap";
import { useTheme } from "../../theme-context";
import { clampHeight, clampWidth } from "../layout";
import { fuzzyScore } from "../../completion";
import { graphemeSafeTruncate } from "../../paste";

const DEFAULT_WIDTH = 40;
const MAX_VISIBLE = 10;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SelectDialogProps {
  readonly title: string;
  readonly options: readonly SelectOption[];
  readonly onSelect: (option: SelectOption) => void;
  readonly onCancel: () => void;
  readonly width?: number;
  readonly placeholder?: string;
}

function filterOptions(options: readonly SelectOption[], query: string): readonly SelectOption[] {
  if (query.length === 0) return options;
  return options
    .filter((option) => fuzzyScore(query, option.label) >= 0 || fuzzyScore(query, option.value) >= 0)
    .sort((a, b) => fuzzyScore(query, b.label) - fuzzyScore(query, a.label));
}

function optionText(option: SelectOption): string {
  return option.description === undefined
    ? option.label
    : `${option.label} — ${option.description}`;
}

/** 通用选择器对话框：搜索框 + 列表 + 上下边框 + 快捷键提示。 */
export function SelectDialog(props: SelectDialogProps) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const results = createMemo(() => filterOptions(props.options, query()));
  const width = createMemo(() => clampWidth(props.width ?? DEFAULT_WIDTH, dimensions().width));
  const height = createMemo(() => clampHeight(MAX_VISIBLE + 2, dimensions().height));
  const visibleCount = createMemo(() => Math.max(1, Math.min(MAX_VISIBLE, height() - 4)));
  const visible = createMemo(() => results().slice(scrollTop(), scrollTop() + visibleCount()));
  const maxLabelWidth = createMemo(() => Math.max(1, width() - 6));
  const hint = createMemo(() => "[↑↓] 选择  [Enter] 确认  [Esc] 取消");

  const keymap = createKeymap();
  keymap.register({ combo: "up", action: "move-up", layer: "tui" });
  keymap.register({ combo: "down", action: "move-down", layer: "tui" });
  keymap.register({ combo: "return", action: "confirm", layer: "tui" });
  keymap.register({ combo: "escape", action: "cancel", layer: "tui" });
  keymap.register({ combo: "ctrl+c", action: "cancel", layer: "tui" });
  keymap.register({ combo: "backspace", action: "backspace", layer: "tui" });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const combo = key.ctrl ? `ctrl+${key.name}` : key.name;
    const action = keymap.resolve(combo)?.action;
    if (action === "move-up" || action === "move-down") {
      key.preventDefault();
      key.stopPropagation();
      const delta = action === "move-down" ? 1 : -1;
      setCursor((value) => {
        const next = Math.min(Math.max(0, results().length - 1), Math.max(0, value + delta));
        const top = scrollTop();
        if (next < top) setScrollTop(next);
        else if (next >= top + visibleCount()) setScrollTop(next - visibleCount() + 1);
        return next;
      });
      return;
    }
    if (action === "confirm") {
      key.preventDefault();
      key.stopPropagation();
      const option = results()[cursor()];
      if (option !== undefined) props.onSelect(option);
      return;
    }
    if (action === "cancel") {
      key.preventDefault();
      key.stopPropagation();
      props.onCancel();
      return;
    }
    if (action === "backspace") {
      key.preventDefault();
      key.stopPropagation();
      setQuery((value) => value.slice(0, -1));
      setCursor(0);
      setScrollTop(0);
      return;
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      key.preventDefault();
      key.stopPropagation();
      setQuery((value) => value + key.name);
      setCursor(0);
      setScrollTop(0);
    }
  });

  return (
    <box
      flexDirection="column"
      border={true}
      title={props.title}
      bottomTitle={hint()}
      width={width()}
      height={height()}
    >
      <text fg={theme.color("accent")}>
        {`> ${query() || (props.placeholder ?? "搜索…")}`}
      </text>
      <For each={visible()}>
        {(option, index) => {
          const absolute = () => scrollTop() + index();
          return (
            <text fg={absolute() === cursor() ? theme.color("accent") : theme.color("text")}>
              {`${absolute() === cursor() ? "> " : "  "}${graphemeSafeTruncate(optionText(option), maxLabelWidth())}`}
            </text>
          );
        }}
      </For>
    </box>
  );
}

export interface DerivedSelectorProps extends Omit<SelectDialogProps, "title"> {
  readonly title?: string;
}

function createDerived(title: string) {
  return (props: DerivedSelectorProps) => (
    <SelectDialog
      title={props.title ?? title}
      options={props.options}
      onSelect={props.onSelect}
      onCancel={props.onCancel}
      width={props.width}
      placeholder={props.placeholder}
    />
  );
}

export const ModelSelector = createDerived("选择模型");
export const SettingsSelector = createDerived("设置");
export const ThinkingSelector = createDerived("思考模式");
export const ScopedModelsSelector = createDerived("作用域模型");
export const TreeSelector = createDerived("选择节点");
export const SessionSelector = createDerived("会话");
export const ThemeSelector = createDerived("主题");
export const LoginDialog = createDerived("登录");
export const TrustSelector = createDerived("信任");
export const ExtensionSelector = createDerived("扩展");
export const ConfigSelector = createDerived("配置");
