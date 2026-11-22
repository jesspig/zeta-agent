import { createMemo, createSignal, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createKeymap } from "../keymap";
import { useTheme } from "../theme-context";
import { clampHeight, clampWidth } from "./layout";
import { fuzzyScore } from "../completion";
import { graphemeSafeTruncate } from "../paste";
import type { RuntimeModelOption } from "../runtime-types";

const MIN_WIDTH = 78;
const MAX_VISIBLE = 12;
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export interface ModelPickerProps {
  readonly models: readonly RuntimeModelOption[];
  readonly current: string | undefined;
  readonly effort: string | undefined;
  readonly onSelect: (value: string) => void;
  readonly onEffort: (effort: string) => void;
  readonly onCancel: () => void;
}

function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

function effortBar(levels: readonly string[], active: string): string {
  if (levels.length === 0) return "";
  const index = levels.indexOf(active);
  const filled = index < 0 ? 0 : index + 1;
  return "█".repeat(filled) + "░".repeat(Math.max(0, levels.length - filled));
}

/** Qoder 风格的模型选择器：搜索 + 分组 + 多列对齐 + 内联思考强度调节。 */
export function ModelPicker(props: ModelPickerProps) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [group, setGroup] = createSignal<string>("All");
  const width = createMemo(() => clampWidth(Math.max(MIN_WIDTH, dimensions().width - 4), dimensions().width));
  const height = createMemo(() => clampHeight(MAX_VISIBLE + 3, dimensions().height));

  const groups = createMemo(() => {
    const names = new Set<string>(["All"]);
    for (const model of props.models) if (model.group !== undefined) names.add(model.group);
    return [...names];
  });

  const matches = createMemo(() => {
    let list = props.models;
    if (group() !== "All") list = list.filter((model) => model.group === group());
    const q = query();
    if (q.length === 0) return list;
    return list
      .filter((model) => fuzzyScore(q, model.name ?? model.value) >= 0 || fuzzyScore(q, model.value) >= 0)
      .sort((a, b) => fuzzyScore(q, b.name ?? b.value) - fuzzyScore(q, a.name ?? a.value));
  });

  const selected = (): RuntimeModelOption | undefined => matches()[cursor()];

  // 滚动窗口：保证光标始终可见，列表超出可视行时可上下浏览。
  const visible = createMemo(() => {
    const list = matches();
    const start = Math.min(scrollTop(), Math.max(0, list.length - MAX_VISIBLE));
    return list.slice(start, start + MAX_VISIBLE);
  });

  const activeEffortLabel = (model: RuntimeModelOption): string => {
    if (model.effort === undefined || model.effort.length === 0) return "-";
    return effortLabel(props.effort ?? model.effort[0]!);
  };

  const move = (delta: number): void => {
    const size = matches().length;
    const next = Math.min(Math.max(0, cursor() + delta), Math.max(0, size - 1));
    setCursor(next);
    // 光标越过可视窗口底部/顶部时滚动。
    const top = scrollTop();
    if (next < top) setScrollTop(next);
    else if (next >= top + MAX_VISIBLE) setScrollTop(next - MAX_VISIBLE + 1);
  };

  const adjustEffort = (delta: number): void => {
    const model = selected();
    const levels = model?.effort ?? [];
    if (levels.length === 0) return;
    const currentEffort = props.effort ?? levels[0]!;
    const index = levels.indexOf(currentEffort);
    const next = Math.min(Math.max(0, (index < 0 ? 0 : index) + delta), levels.length - 1);
    props.onEffort(levels[next]!);
  };

  const keymap = createKeymap();
  keymap.register({ combo: "up", action: "up", layer: "tui" });
  keymap.register({ combo: "down", action: "down", layer: "tui" });
  keymap.register({ combo: "pageup", action: "page-up", layer: "tui" });
  keymap.register({ combo: "pagedown", action: "page-down", layer: "tui" });
  keymap.register({ combo: "left", action: "effort-down", layer: "tui" });
  keymap.register({ combo: "right", action: "effort-up", layer: "tui" });
  keymap.register({ combo: "return", action: "select", layer: "tui" });
  keymap.register({ combo: "escape", action: "cancel", layer: "tui" });
  keymap.register({ combo: "tab", action: "next-group", layer: "tui" });
  keymap.register({ combo: "backspace", action: "backspace", layer: "tui" });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const combo = key.ctrl ? `ctrl+${key.name}` : key.name;
    const action = keymap.resolve(combo)?.action;
    if (action === "up") {
      key.preventDefault();
      key.stopPropagation();
      move(-1);
      return;
    }
    if (action === "down") {
      key.preventDefault();
      key.stopPropagation();
      move(1);
      return;
    }
    if (action === "page-up" || action === "page-down") {
      key.preventDefault();
      key.stopPropagation();
      move(action === "page-down" ? MAX_VISIBLE : -MAX_VISIBLE);
      return;
    }
    if (action === "effort-down" || action === "effort-up") {
      key.preventDefault();
      key.stopPropagation();
      adjustEffort(action === "effort-up" ? 1 : -1);
      return;
    }
    if (action === "select") {
      key.preventDefault();
      key.stopPropagation();
      const model = selected();
      if (model !== undefined) props.onSelect(model.value);
      return;
    }
    if (action === "cancel") {
      key.preventDefault();
      key.stopPropagation();
      props.onCancel();
      return;
    }
    if (action === "next-group") {
      key.preventDefault();
      key.stopPropagation();
      const list = groups();
      setGroup((value) => list[(list.indexOf(value) + 1) % list.length]!);
      setCursor(0);
      setScrollTop(0);
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

  const nameWidth = () => Math.max(14, Math.floor(width() * 0.34));
  const effortWidth = () => 12;
  const ctxWidth = () => 8;
  const hint = () => "[/] 搜索  [↑↓] 选择  [←→] 思考强度  [Tab] 分组  [Enter] 确定  [Esc] 返回";

  const row = (model: RuntimeModelOption): string => {
    const levels = model.effort ?? [];
    const bar = levels.length > 0 ? effortBar(levels, props.effort ?? levels[0]!) : "-";
    return (
      `${graphemeSafeTruncate(model.name ?? model.value, nameWidth()).padEnd(nameWidth())} ` +
      `${graphemeSafeTruncate(bar, effortWidth()).padEnd(effortWidth())} ` +
      `${graphemeSafeTruncate(model.context ?? "-", ctxWidth()).padEnd(ctxWidth())} ${model.price ?? "-"}`
    );
  };

  return (
    <box flexDirection="column" border={true} title="选择模型" bottomTitle={hint()} width={width()} height={height()}>
      <text fg={theme.color("muted")}>
        {`搜索: ${query() || "输入过滤…"}    分组: ${groups().map((g) => (g === group() ? `[${g}]` : g)).join(" ")}`}
      </text>
      <text fg={theme.color("borderMuted")}>
        {`${"模型".padEnd(nameWidth())} ${"思考强度".padEnd(effortWidth())} ${"上下文".padEnd(ctxWidth())} 价格`}
      </text>
      <For each={visible()}>
        {(model, index) => {
          const absolute = () => scrollTop() + index();
          return (
            <text fg={absolute() === cursor() ? theme.color("accent") : theme.color("text")}>
              {`${absolute() === cursor() ? "> " : "  "}${row(model)}`}
            </text>
          );
        }}
      </For>
      <Show when={matches().length > MAX_VISIBLE}>
        <text fg={theme.color("dim")}>
          {`  … ${scrollTop() + 1}-${Math.min(scrollTop() + MAX_VISIBLE, matches().length)} / ${matches().length}`}
        </text>
      </Show>
      <Show when={(selected()?.effort?.length ?? 0) > 0}>
        <text fg={theme.color("thinking")}>{`  思考强度: ← ${activeEffortLabel(selected()!)} →`}</text>
      </Show>
    </box>
  );
}
