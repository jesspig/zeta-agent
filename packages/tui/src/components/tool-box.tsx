import { For, createSignal, onCleanup, onMount } from "solid-js";
import { useKeyboard } from "@opentui/solid";
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

/** T-06 三态背景：pending(running)/success(done)/error 各自独立色值。 */
export const STATUS_BACKGROUND = {
  pending: "#16263f",
  success: "#163326",
  error: "#3d1f22",
} as const;

const STATUS_COLOR = {
  running: "#58a6ff",
  done: "#7ee787",
  error: "#ff7b72",
} as const;

function backgroundFor(status: ToolStateStatus): string {
  if (status === "running") return STATUS_BACKGROUND.pending;
  if (status === "done") return STATUS_BACKGROUND.success;
  return STATUS_BACKGROUND.error;
}

export type ResultTone = "success" | "error";

/** 把 isError 归一为结果色调，供背景/图标复用。 */
export function statusOfResult(result: { readonly isError: boolean }): ResultTone {
  return result.isError ? "error" : "success";
}

const PREVIEW_LIMIT = 10;

/** 预览文本：>10 行折叠为 N more lines 提示，展开后显示全文。 */
export function formatPreview(text: string, expanded: boolean): string {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LIMIT || expanded) return text;
  const hidden = lines.length - PREVIEW_LIMIT;
  return `${lines.slice(0, PREVIEW_LIMIT).join("\n")}\n… (${hidden} more lines, Ctrl+O to expand)`;
}

/** renderShell 扩展点：外部工具可注入 shell 结果格式化；此处提供默认实现。 */
export function renderShell(shell: { readonly command: string; readonly exitCode?: number } | null): string {
  if (shell === null) return "";
  const head = `$ ${shell.command}`;
  return shell.exitCode === undefined || shell.exitCode === 0 ? head : `${head} (exit ${shell.exitCode})`;
}

export interface MediaResult {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export type ResolvedMedia =
  | { readonly kind: "image"; readonly mimeType: string; readonly bytes: Uint8Array }
  | { readonly kind: "text"; readonly text: string };

/**
 * 图片渲染/text 降级（OQ-01）：有图片数据时走 image kind；无数据时返回文本降级占位，
 * 不在业务组件直接 import @opentui/core 的 ImageRenderable。
 */
export function resolveMedia(media: MediaResult | undefined): ResolvedMedia {
  if (media !== undefined && media.mimeType.startsWith("image/") && media.bytes.length > 0) {
    return { kind: "image", mimeType: media.mimeType, bytes: media.bytes };
  }
  return { kind: "text", text: "[image: 无可用数据，已降级为文本占位]" };
}

function argsText(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function resultText(state: ToolState): string {
  if (state.result === undefined || state.result === null) return "";
  if (typeof state.result === "string") return state.result;
  try {
    return JSON.stringify(state.result);
  } catch {
    return String(state.result);
  }
}

export interface ToolBoxProps {
  readonly source: EventSource;
  readonly controller?: ToolBoxController;
  /** renderShell 扩展点：自定义 shell 工具的结果渲染。 */
  readonly shellRenderer?: (state: ToolState) => string;
}

export function ToolBox(props: ToolBoxProps) {
  const theme = useTheme();
  const signals = createAgentSignals(props.source);
  const controller = props.controller ?? createToolBoxController();
  const [states, setStates] = createSignal<readonly ToolState[]>([]);
  const [previewExpanded, setPreviewExpanded] = createSignal<ReadonlySet<string>>(new Set<string>());

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      key.stopPropagation();
      const current = states();
      const target = current.find((state) => resultText(state).split("\n").length > PREVIEW_LIMIT);
      if (target !== undefined) {
        setPreviewExpanded((set) => {
          const next = new Set(set);
          if (next.has(target.id)) next.delete(target.id);
          else next.add(target.id);
          return next;
        });
      }
    }
  });

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

  const renderPreview = (state: ToolState) => {
    const text = props.shellRenderer ? props.shellRenderer(state) : resultText(state);
    if (text.length === 0) return "";
    return formatPreview(text, previewExpanded().has(state.id));
  };

  return (
    <box flexDirection="column">
      <For each={states()}>
        {(state) => (
          <box flexDirection="column" backgroundColor={backgroundFor(state.status)}>
            <text fg={STATUS_COLOR[state.status]}>
              {`${state.name} ${STATUS_LABEL[state.status]}`}
            </text>
            {renderArgs(state) ? <text fg={theme.color("muted")}>{renderArgs(state)}</text> : null}
            {renderPreview(state) ? <text fg={theme.color("text")}>{renderPreview(state)}</text> : null}
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
