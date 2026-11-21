import { CliRenderer } from "@opentui/core";
import { render as openTuiRender, useKeyboard } from "@opentui/solid";
import { createSignal, For, Show, createMemo } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { createKeymap } from "./keymap";
import { ConfirmOverlay } from "./components/overlay";
import { clampWidth } from "./components/layout";
import { FooterBridge } from "./components/footer-bridge";
import { ThemeProvider, useTheme } from "./theme-context";
import { createOscBridge } from "./osc";
import { CommandPaletteView, type Command } from "./command-palette";
import {
  ModelSelector,
  SettingsSelector,
  ThemeSelector,
  type SelectOption,
} from "./components/selectors/selectors";
import { useZetaSlots, type ZetaNativeSlots } from "./slots-native";
import type { SolidPlugin } from "./slots-native";
import { resolveDualMode } from "./dual-mode";
import { createAgentSignals, type AgentSignals, type EventSource } from "./signal";
import { RichMessageList } from "./components/message";
import { ZetaEditor } from "./components/editor";
import { ViewportLayout } from "./components/layout-view";
import { WorkIndicator } from "./components/status-border";
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
  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%" height="100%">
      <text fg={theme.color("accent")}>{props.title}</text>
      <box height={1} />
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
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
  readonly commandList?: readonly { readonly id: string; readonly title: string }[];
  readonly plugins?: readonly SolidPlugin<ZetaNativeSlots>[];
}) {
  const [lines, setLines] = createSignal<readonly string[]>(props.messages.map(messageLine));
  const [overlayOpen, setOverlayOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  type SelectorKind = "model" | "theme" | "settings";
  const [selectorOpen, setSelectorOpen] = createSignal<SelectorKind | undefined>(undefined);
  const { BoundSlot } = useZetaSlots(props.plugins);

  const DEMO_OPTIONS: Readonly<Record<SelectorKind, readonly SelectOption[]>> = {
    model: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "claude-sonnet", label: "Claude Sonnet" },
    ],
    theme: [
      { value: "dark", label: "dark" },
      { value: "light", label: "light" },
    ],
    settings: [
      { value: "editor", label: "编辑器" },
      { value: "keymap", label: "快捷键" },
    ],
  };
  const SELECTOR_TITLES: Readonly<Record<SelectorKind, string>> = {
    model: "选择模型",
    theme: "主题",
    settings: "设置",
  };
  const paletteCommands = (): readonly Command[] => [
    ...(props.commandList ?? []),
    { id: "model", title: SELECTOR_TITLES.model },
    { id: "theme", title: SELECTOR_TITLES.theme },
    { id: "settings", title: SELECTOR_TITLES.settings },
  ];
  props.onPush((message) => setLines((current) => [...current, messageLine(message)]));

  const keymap = createKeymap();
  keymap.register({ combo: "escape", action: "overlay", layer: "tui" });
  keymap.register({ combo: "ctrl+c", action: "exit", layer: "tui" });
  // 沿用常见编辑语义：ctrl+k 归编辑器 kill-to-end；overlay 切换改用 ctrl+g，避免与编辑键冲突。
  keymap.register({ combo: "ctrl+g", action: "confirm", layer: "app" });
  keymap.register({ combo: "ctrl+p", action: "palette", layer: "app" });
  keymap.register({ combo: "ctrl+o", action: "model-selector", layer: "app" });
  keymap.register({ combo: "ctrl+t", action: "theme-selector", layer: "app" });
  keymap.register({ combo: "ctrl+s", action: "settings-selector", layer: "app" });

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
    if (action === "palette") {
      setPaletteOpen((open) => !open);
      return;
    }
    if (action === "model-selector") {
      setSelectorOpen((kind) => (kind === "model" ? undefined : "model"));
      return;
    }
    if (action === "theme-selector") {
      setSelectorOpen((kind) => (kind === "theme" ? undefined : "theme"));
      return;
    }
    if (action === "settings-selector") {
      setSelectorOpen((kind) => (kind === "settings" ? undefined : "settings"));
      return;
    }
    // overlay 打开时按常见交互语义处理：Enter 确认。
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
      <ViewportLayout
        transcript={
          <Show when={props.source} fallback={<ZetaFrame title={props.title} lines={lines()} />}>
            {(sourceAccessor: () => EventSource) => <RichMessageList source={sourceAccessor()} />}
          </Show>
        }
        dock={
          <>
            <WorkIndicator source={props.source} />
            <ZetaEditor
              onSubmit={(text) => {
                if (text === "exit" || text === "quit") {
                  props.onExit();
                  return;
                }
                return props.onSubmit?.(text);
              }}
            />
            <BoundSlot name="footer" mode="replace">
              <FooterBridge source={props.source} />
            </BoundSlot>
          </>
        }
      />
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
      <Show when={paletteOpen()}>
        <CommandPaletteView
          commands={paletteCommands()}
          onRun={(command: Command) => {
            setPaletteOpen(false);
            const known: SelectorKind[] = ["model", "theme", "settings"];
            if ((known as readonly string[]).includes(command.id)) {
              setSelectorOpen(command.id as SelectorKind);
              return;
            }
            void props.onSubmit?.(`/${command.id}`);
          }}
          onCancel={() => setPaletteOpen(false)}
        />
      </Show>
      <Show when={selectorOpen() !== undefined}>
        {() => {
          const kind = selectorOpen() as SelectorKind;
          const shared = {
            options: DEMO_OPTIONS[kind],
            onSelect: (option: SelectOption) => {
              setSelectorOpen(undefined);
              void props.onSubmit?.(`/${kind}:${option.value}`);
            },
            onCancel: () => setSelectorOpen(undefined),
          };
          if (kind === "model") return <ModelSelector {...shared} title={SELECTOR_TITLES[kind]} />;
          if (kind === "theme") return <ThemeSelector {...shared} title={SELECTOR_TITLES[kind]} />;
          return <SettingsSelector {...shared} title={SELECTOR_TITLES[kind]} />;
        }}
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
  // OSC 7501/9;4：向终端上报工作状态与进度；退出时复位为 done。
  const releaseOsc = signals
    ? createOscBridge(signals, (sequence) => process.stdout.write(sequence))
    : undefined;

  const onSubmit = (text: string): void | Promise<void> => {
    if (options.commands && text.startsWith("/")) {
      return options.commands(text);
    }
    return options.onSubmit?.(text);
  };

  const exit = () => {
    releaseOsc?.();
    signals?.dispose();
    renderer.destroy();
    resolveClosed();
  };

  await openTuiRender(
    () => (
      <ThemeProvider initial={options.theme ?? "dark"}>
        <ZetaApp
          title={options.title ?? "zeta"}
          messages={options.messages ?? []}
          source={options.source}
          onPush={(sink) => {
            push = sink;
          }}
          onSubmit={onSubmit}
          commandList={options.commandList}
          plugins={options.plugins}
          onExit={() => {
            options.onExit?.();
            exit();
          }}
        />
      </ThemeProvider>
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
