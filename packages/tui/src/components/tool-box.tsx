import { For, createSignal, createMemo, onCleanup, onMount } from "solid-js";
import { useTheme } from "../theme-context";
import type { AgentEvent } from "@zeta-agent/agent";
import {
  createAgentSignals,
  type EventSource,
  type ToolState,
  type ToolStateStatus,
} from "../signal";

export interface ToolBoxController {
  toggle(id: string): void;
  isExpanded(id: string): boolean;
}

export function createToolBoxController(): ToolBoxController {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set<string>());
  return {
    toggle(id) {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    isExpanded(id) {
      return expanded().has(id);
    },
  };
}

const STATUS_LABEL: Record<ToolStateStatus, string> = {
  running: "running",
  done: "done",
  error: "error",
};

const STATUS_COLOR = {
  running: "#58a6ff",
  done: "#7ee787",
  error: "#ff7b72",
} as const;

function argsText(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export interface ToolBoxProps {
  readonly source: EventSource;
  readonly controller?: ToolBoxController;
}

export function ToolBox(props: ToolBoxProps) {
  const theme = useTheme();
  const signals = createAgentSignals(props.source);
  const controller = props.controller ?? createToolBoxController();
  const [states, setStates] = createSignal<readonly ToolState[]>([]);

  onMount(() => {
    const off = signals.toolStates.subscribe((map) => {
      setStates([...map.values()]);
    });
    onCleanup(() => {
      off();
      signals.dispose();
    });
  });

  const renderArgs = (state: ToolState) =>
    controller.isExpanded(state.id) ? argsText(state.args) : "";

  return (
    <box flexDirection="column">
      <For each={states()}>
        {(state) => (
          <box flexDirection="column">
            <text fg={STATUS_COLOR[state.status]}>
              {`${state.name} ${STATUS_LABEL[state.status]}`}
            </text>
            {renderArgs(state) ? <text fg={theme.color("muted")}>{renderArgs(state)}</text> : null}
          </box>
        )}
      </For>
      {(() => {
        const thinking = signals.thinking();
        return thinking ? <text fg={theme.color("thinking")}>thinking</text> : null;
      })()}
    </box>
  );
}

export type { AgentEvent };
