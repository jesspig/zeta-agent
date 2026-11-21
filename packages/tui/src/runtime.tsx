import { CliRenderer } from "@opentui/core";
import { render as openTuiRender, useKeyboard } from "@opentui/solid";
import { createSignal, For, Show, createMemo } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { createKeymap } from "./keymap";
import { ConfirmOverlay } from "./components/overlay";
import { clampWidth } from "./components/layout";
import { FooterBridge } from "./components/footer-bridge";
import { resolveDualMode } from "./dual-mode";
import { createAgentSignals, type AgentSignals, type EventSource } from "./signal";
import { RichMessageList } from "./components/message";
import { ZetaEditor } from "./components/editor";
import type { RuntimeMessage, RuntimeTuiHandle, RuntimeTuiOptions } from "./runtime-types";

export type { RuntimeMessage, RuntimeTuiHandle, RuntimeTuiOptions } from "./runtime-types";

function messageLine(message: RuntimeMessage): string {
  return `${message.role}: ${String(message.content)}`;
}

export interface ZetaFrameProps {
  readonly title: string;
  readonly lines: readonly string[];
}

export function ZetaFrame(props: ZetaFrameProps) {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <text fg="#7ee787">{props.title}</text>
      <box height={1} />
      <scrollbox flexGrow={1}>
        <For each={props.lines}>{(line) => <text>{line}</text>}</For>
      </scrollbox>
    </box>
  );
}

export function ZetaApp(props: {
  readonly title: string;
  readonly messages: readonly RuntimeMessage[];
  readonly source?: EventSource;
  readonly onPush: (sink: (message: RuntimeMessage) => void) => void;
  readonly onSubmit?: (text: string) => void | Promise<void>;
  readonly onExit: () => void;
}) {
  const [lines, setLines] = createSignal<readonly string[]>(props.messages.map(messageLine));
  const [overlayOpen, setOverlayOpen] = createSignal(false);
  props.onPush((message) => setLines((current) => [...current, messageLine(message)]));

  const keymap = createKeymap();
  keymap.register({ combo: "escape", action: "overlay", layer: "tui" });
  keymap.register({ combo: "ctrl+c", action: "exit", layer: "tui" });
  // pi 语义：ctrl+k 归编辑器 kill-to-end；overlay 切换改用 ctrl+g，避免与编辑键冲突。
  keymap.register({ combo: "ctrl+g", action: "confirm", layer: "app" });

  const dimensions = useTerminalDimensions();
  const width = createMemo(() => clampWidth(100, dimensions().width));

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const combo = key.ctrl ? `ctrl+${key.name}` : key.name;
    const action = keymap.resolve(combo)?.action;
    if (action === "exit") {
      props.onExit();
      return;
    }
    if (action === "overlay") {
      // Esc 只负责取消/关闭，避免与 toggle 重复导致 overlay 关不掉。
      setOverlayOpen(false);
      return;
    }
    if (action === "confirm") {
      setOverlayOpen((open) => !open);
      return;
    }
    // overlay 打开时按 pi 语义处理：Enter 确认。
    if (overlayOpen() && key.name === "return") {
      key.preventDefault();
      key.stopPropagation();
      setOverlayOpen(false);
      props.onExit();
    }
  });

  function submit(value: string) {
    const text = value.trim();
    if (text.length === 0) return;
    if (text === "exit" || text === "quit") {
      props.onExit();
      return;
    }
    setLines((current) => [...current, `user: ${text}`]);
    void props.onSubmit?.(text);
  }

  return (
    <>
      <Show when={props.source} fallback={<ZetaFrame title={props.title} lines={lines()} />}>
        {(sourceAccessor: () => EventSource) => <RichMessageList source={sourceAccessor()} />}
      </Show>
      <ZetaEditor
        onSubmit={(text) => {
          if (text === "exit" || text === "quit") {
            props.onExit();
            return;
          }
          return props.onSubmit?.(text);
        }}
      />
      <FooterBridge source={props.source} />
      <Show when={overlayOpen()}>
        <ConfirmOverlay
          message="确定退出？"
          onConfirm={() => {
            setOverlayOpen(false);
            props.onExit();
          }}
          onCancel={() => setOverlayOpen(false)}
        />
      </Show>
    </>
  );
}

export async function renderTui(options: RuntimeTuiOptions = {}): Promise<RuntimeTuiHandle> {
  const renderer = new CliRenderer(
    process.stdin,
    process.stdout,
    process.stdout.columns || 80,
    process.stdout.rows || 24,
    { screenMode: resolveDualMode(options.mode).screenMode },
  );
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let push: (message: RuntimeMessage) => void = () => {};

  const signals: AgentSignals | undefined = options.source
    ? createAgentSignals(options.source)
    : undefined;

  const onSubmit = (text: string): void | Promise<void> => {
    if (options.commands && text.startsWith("/")) {
      return options.commands(text);
    }
    return options.onSubmit?.(text);
  };

  const exit = () => {
    signals?.dispose();
    renderer.destroy();
    resolveClosed();
  };

  await openTuiRender(
    () => (
      <ZetaApp
        title={options.title ?? "zeta"}
        messages={options.messages ?? []}
        source={options.source}
        onPush={(sink) => {
          push = sink;
        }}
        onSubmit={onSubmit}
        onExit={() => {
          options.onExit?.();
          exit();
        }}
      />
    ),
    renderer,
  );

  return {
    appendMessage(message) {
      push(message);
    },
    waitForExit() {
      return closed;
    },
    getSignals() {
      return signals;
    },
    async destroy() {
      exit();
      await closed;
      await renderer.closed;
    },
  };
}
