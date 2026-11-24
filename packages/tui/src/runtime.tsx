import { CliRenderer } from "@opentui/core";
import { render as openTuiRender, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { encodeControlFrame, type ControlAction } from "@zeta-agent/agent";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createApprovalUiChannel, ApprovalOverlay } from "./approval-ui";
import type { ApprovalUiChannel } from "./approval-ui";
import type { BackendSize, RendererBackend } from "./backend";
import { createRuntimeKeymap, resolveKittyCombo } from "./keymap";
import { ConnectDialog } from "./components/connect-dialog";
import { ModelPicker } from "./components/model-picker";
import { ConfirmOverlay } from "./components/overlay";
import { clampWidth } from "./components/layout";
import { FooterBridge } from "./components/footer-bridge";
import { ThemeProvider, useTheme } from "./theme-context";
import { createOscBridge, createOscReporter } from "./osc";
import { OscProvider } from "./osc-context";
import { createUsageTracker, initialTelemetry } from "./usage";
import type { AgentUsageTelemetry } from "./telemetry-types";
import { CommandPaletteView, type Command } from "./command-palette";
import {
  SelectDialog,
  SettingsSelector,
  ThemeSelector,
  type SelectOption,
} from "./components/selectors/selectors";
import { createReactiveSlotHost } from "./slots-reactive";
import type { ZetaNativeSlots, SolidPlugin } from "./slots-native";
import { resolveDualMode } from "./dual-mode";
import { createAgentSignals, type AgentSignals, type EventSource } from "./signal";
import { Transcript, type TranscriptResources } from "./components/transcript";
import { ZetaEditor, type EditorHandle, type SubmitMode } from "./components/editor";
import { ViewportLayout } from "./components/layout-view";
import type { RuntimeMessage, RuntimeModelOption, RuntimeTuiHandle, RuntimeTuiOptions } from "./runtime-types";
import type { SlashCommand } from "./slash";
import type { TuiThemeName } from "./runtime-types";

export type { RuntimeMessage, RuntimeTuiHandle, RuntimeTuiOptions, RuntimeResources, RuntimeModelOption } from "./runtime-types";

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

const HELP_TEXT: readonly string[] = [
  "快捷键",
  "  Enter        提交（Shift+Enter 换行）",
  "  Alt+Enter    排队 follow-up（下一轮消费）",
  "  Ctrl+Shift+C 复制输入到系统剪贴板",
  "  Alt+Up       取回最早一条 follow-up",
  "  Esc          中止当前运行",
  "  Ctrl+C       清空输入",
  "  Ctrl+D       退出（输入为空时）",
  "  Ctrl+O       展开/折叠工具输出",
  "  Ctrl+T       展开/折叠思考内容",
  "  Ctrl+L       选择模型",
  "  Ctrl+P       下一个模型",
  "  Up/Down      浏览输入历史",
  "  Tab          补全斜杠命令",
  "  /            打开命令候选",
];

function HelpOverlay(props: { readonly onClose: () => void }) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const width = createMemo(() => Math.min(clampWidth(64, dimensions().width - 4), Math.max(20, dimensions().width - 4)));
  return (
    <box
      position="absolute"
      left={2}
      bottom={6}
      width={width()}
      flexDirection="column"
      backgroundColor={theme.color("surface")}
      border={true}
      borderColor={theme.color("borderAccent")}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <For each={HELP_TEXT}>{(line) => <text fg={theme.color(line.startsWith("  ") ? "text" : "mdHeading")}>{line}</text>}</For>
      <text fg={theme.color("dim")}>Esc 关闭</text>
    </box>
  );
}

export interface ZetaAppProps {
  readonly title: string;
  readonly messages: readonly RuntimeMessage[];
  readonly source?: EventSource;
  readonly onPush: (sink: (message: RuntimeMessage) => void) => void;
  readonly onSubmit?: (text: string, mode?: SubmitMode) => boolean | void | Promise<boolean | void>;
  readonly onSubmitError?: (error: unknown) => void;
  readonly onEditorHandle?: (handle: EditorHandle) => void;
  readonly onExit: () => void;
  readonly onAbort?: () => void;
  readonly commandList?: readonly { readonly id: string; readonly title: string }[];
  readonly commandCatalog?: readonly SlashCommand[];
  readonly onCommand?: (text: string) => boolean | void | Promise<boolean | void>;
  readonly plugins?: readonly SolidPlugin<ZetaNativeSlots>[];
  readonly cwd?: string;
  readonly model?: string;
  readonly models?: readonly string[];
  readonly onModelChange?: (model: string) => void;
  readonly provider?: string;
  readonly resources?: TranscriptResources;
  readonly theme?: TuiThemeName;
  /** 连接回调：宿主设置连接并异步拉取模型列表。 */
  readonly onConnect?: (url: string, key: string) => void;
  /** 连接对话框初始值（环境变量兜底）。 */
  readonly connection?: { readonly url?: string; readonly key?: string };
  /** 当前可选模型选项（宿主异步刷新后经 handle.setModelOptions 更新）。 */
  readonly modelList?: readonly RuntimeModelOption[];
  /** 当前模型（宿主异步更新）。 */
  readonly currentModel?: string;
  /** 当前思考强度档位。 */
  readonly reasoningEffort?: string;
  /** 思考强度变更回调。 */
  readonly onEffortChange?: (effort: string) => void;
  /** /new：宿主执行真实会话替换（清空历史并隔离在途事件）。 */
  readonly onNewSession?: () => void | Promise<void>;
  /** 真实遥测：token/成本来自 usage 事件，分支/会话由宿主提供。 */
  readonly telemetry?: AgentUsageTelemetry;
  /** user/app/TUI 三层自定义键位。 */
  readonly keyBindings?: readonly import("./keymap").KeyBinding[];
  /** 与 headless/RPC 共享的审批 UI 通道。 */
  readonly approvalUi?: ApprovalUiChannel;
}

/** 根界面：视口（对话）+ 停靠区（编辑器/footer）+ 覆盖层。 */
export function ZetaApp(props: ZetaAppProps) {
  const theme = useTheme();
  const [lines, setLines] = createSignal<readonly RuntimeMessage[]>(props.messages);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [overlayOpen, setOverlayOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [themeName, setThemeName] = createSignal<TuiThemeName>(props.theme ?? "dark");
  const [activeModel, setActiveModel] = createSignal<string | undefined>(props.model);
  const [effort, setEffort] = createSignal<string | undefined>(props.reasoningEffort);
  const [resetKey, setResetKey] = createSignal(0);
  type SelectorKind = "model" | "theme" | "settings" | "connect";
  const [selectorOpen, setSelectorOpen] = createSignal<SelectorKind | undefined>(undefined);
  const slotHost = createReactiveSlotHost<ZetaNativeSlots>(useRenderer());
  const BoundSlot = slotHost.BoundSlot;
  createEffect(() => {
    slotHost.apply(props.plugins ?? []);
  });
  onCleanup(() => slotHost.dispose());
  const [status, setStatus] = createSignal<"idle" | "streaming" | "tool">("idle");
  const [editorText, setEditorText] = createSignal("");
  let lastCtrlC = 0;

  if (props.source !== undefined) {
    const signals = createAgentSignals(props.source);
    onMount(() => {
      const off = signals.status.subscribe((value) => setStatus(value));
      onCleanup(() => {
        off();
        signals.dispose();
      });
    });
  }

  const SELECTOR_TITLES: Readonly<Record<SelectorKind, string>> = {
    model: "选择模型",
    theme: "主题",
    settings: "设置",
    connect: "连接 API",
  };

  const modelOptions = (): readonly SelectOption[] => {
    const provided = props.modelList;
    if (provided !== undefined && provided.length > 0) {
      return provided.map((option) => ({
        value: option.value,
        label: option.label ?? option.value,
        ...(option.description !== undefined ? { description: option.description } : {}),
      }));
    }
    const ids = props.models ?? [];
    if (ids.length > 0) return ids.map((id) => ({ value: id, label: id }));
    // 未配置 API/Key 时不显示任何模型（无模型目录兜底）。
    return [];
  };

  const DEMO_OPTIONS = (): Readonly<Record<SelectorKind, readonly SelectOption[]>> => ({
    model: modelOptions(),
    connect: [],
    theme: [
      { value: "system", label: "system" },
      { value: "dark", label: "dark" },
      { value: "light", label: "light" },
    ],
    settings: [
      { value: "editor", label: "编辑器" },
      { value: "keymap", label: "快捷键" },
    ],
  });

  const catalog = createMemo<readonly SlashCommand[]>(() => {
    const builtin: SlashCommand[] = [
      { name: "help", description: "显示帮助与快捷键" },
      { name: "clear", description: "清空当前会话视图" },
      { name: "new", description: "新建会话" },
      { name: "model", description: "选择模型", argumentHint: "[model]" },
      { name: "theme", description: "切换主题", argumentHint: "[system|dark|light]" },
      { name: "settings", description: "打开设置" },
      { name: "connect", description: "设置 API 并拉取模型列表" },
      { name: "compact", description: "压缩会话上下文" },
      { name: "export", description: "导出会话" },
      { name: "quit", description: "退出" },
    ];
    const seen = new Set(builtin.map((command) => command.name));
    const extra = (props.commandCatalog ?? []).filter((command) => !seen.has(command.name));
    return [...builtin, ...extra];
  });

  const paletteCommands = (): readonly Command[] => [
    ...catalog().map((command) => ({ id: command.name, title: `${command.name} — ${command.description ?? ""}` })),
    ...(props.commandList ?? []).filter((entry) => !catalog().some((command) => command.name === entry.id)),
  ];

  props.onPush((message) => setLines((current) => [...current, message]));

  const notify = (text: string): void => {
    setLines((current) => [...current, { role: "notice", content: text }]);
  };

  const runLocalCommand = (input: string): boolean => {
    const trimmed = input.trim();
    const match = /^\/([A-Za-z0-9_-]+)(?::|\s+)?(.*)$/.exec(trimmed);
    if (match === null) return false;
    const name = match[1] ?? "";
    const rest = (match[2] ?? "").trim();
    switch (name) {
      case "help":
        setHelpOpen(true);
        return true;
      case "clear":
        setLines([]);
        setResetKey((value) => value + 1);
        return true;
      case "new":
        // 视图总是清空；宿主回调负责清空真正的会话上下文（agent.reset）。
        setLines([]);
        setResetKey((value) => value + 1);
        if (props.onNewSession !== undefined) void props.onNewSession();
        notify("✓ New session started");
        return true;
      case "quit":
      case "exit":
        props.onExit();
        return true;
      case "theme":
        if (rest === "dark" || rest === "light" || rest === "system") {
          setThemeName(rest);
          theme.setActive(rest);
          notify(`theme: ${rest}`);
        } else {
          setSelectorOpen("theme");
        }
        return true;
      case "model": {
        // 优先从动态发现的 modelList 选择，兼容旧宿主只传 models 的情况。
        const known = (props.modelList ?? []).map((option) => option.value);
        const candidates = known.length > 0 ? known : (props.models ?? []);
        if (rest.length > 0 && candidates.includes(rest)) {
          setActiveModel(rest);
          props.onModelChange?.(rest);
          notify(`model: ${rest}`);
        } else {
          setSelectorOpen("model");
        }
        return true;
      }
      case "settings":
        setSelectorOpen("settings");
        return true;
      case "connect":
        setSelectorOpen("connect");
        return true;
      default:
        return false;
    }
  };

  const submit = async (text: string, mode?: SubmitMode): Promise<boolean> => {
    const value = text.trim();
    if (value.length === 0) return false;
    if (value.startsWith("/")) {
      if (runLocalCommand(value)) return true;
      if (props.onCommand !== undefined) {
        return (await props.onCommand(value)) !== false;
      }
      notify(`未知命令：${value}（/help 查看可用命令）`);
      return false;
    }
    if (props.onSubmit === undefined) return false;
    return (await props.onSubmit(value, mode)) !== false;
  };

  const keymap = createRuntimeKeymap({ bindings: props.keyBindings });

  useKeyboard((key) => {
    if (key.eventType === "release") return;

    // 与目标终端 UI 一致：Ctrl+C 清空输入；空输入下 500ms 内二次按下退出。
    if (key.ctrl && key.name === "c") {
      if (editorText().trim().length === 0) {
        const now = Date.now();
        if (now - lastCtrlC < 500) {
          key.preventDefault();
          key.stopPropagation();
          props.onExit();
          return;
        }
        lastCtrlC = now;
      } else {
        lastCtrlC = 0;
      }
    }
    const action = keymap.resolve(resolveKittyCombo(key))?.action;
    if (action === "exit") {
      if (editorText().trim().length === 0) {
        key.preventDefault();
        key.stopPropagation();
        props.onExit();
      }
      return;
    }
    if (action === "confirm") {
      key.preventDefault();
      key.stopPropagation();
      setOverlayOpen((open) => !open);
      return;
    }
    if (action === "palette") {
      key.preventDefault();
      key.stopPropagation();
      setPaletteOpen((open) => !open);
      return;
    }
    if (action === "abort") {
      if (helpOpen()) {
        key.preventDefault();
        key.stopPropagation();
        setHelpOpen(false);
        return;
      }
      if (overlayOpen()) {
        key.preventDefault();
        key.stopPropagation();
        setOverlayOpen(false);
        return;
      }
      // 选择器/命令面板自行处理 Esc；编辑器负责关闭候选并触发 onAbort。
      return;
    }
    if (overlayOpen() && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      key.stopPropagation();
      setOverlayOpen(false);
      props.onExit();
      return;
    }
    if (action === "model-selector") {
      key.preventDefault();
      key.stopPropagation();
      setSelectorOpen((kind) => (kind === "model" ? undefined : "model"));
      return;
    }
    // 连接对话框统一由 /connect 命令打开，不再占用 Ctrl+K。
  });

  return (
    <>
      <ViewportLayout
        transcript={
          <Show
            when={props.source}
            fallback={<ZetaFrame title={props.title} lines={lines().map(messageLine)} />}
          >
            {(sourceAccessor: () => EventSource) => (
              <Transcript
                source={sourceAccessor()}
                cwd={props.cwd}
                resources={props.resources}
                resetKey={resetKey()}
                notices={lines()
                  .filter((message) => message.role === "notice")
                  .map((message, index) => ({
                    kind: "notice" as const,
                    id: `n${index}-${String(message.content)}`,
                    tone: "muted" as const,
                    text: String(message.content),
                  }))}
              />
            )}
          </Show>
        }
        dock={
          <>
            <Show
              when={selectorOpen() !== undefined}
              fallback={
                <Show when={!paletteOpen() && !overlayOpen() && !helpOpen()}>
                  <ZetaEditor
                    commands={catalog()}
                    status={status()}
                    placeholder="输入消息，/ 查看命令"
                    onChange={setEditorText}
                    onEscape={() => props.onAbort?.()}
                    onSubmitWithMode={(text, mode) => submit(text, mode)}
                    onSubmitError={props.onSubmitError}
                    onHandle={props.onEditorHandle}
                  />
                </Show>
              }
            >
              {() => {
                const kind = selectorOpen() as SelectorKind;
                const options = DEMO_OPTIONS()[kind];
                const shared = {
                  options:
                    options.length > 0
                      ? options
                      : kind === "model"
                        ? [{ value: "__connect__", label: "未配置 API — 请用 /connect 连接" }]
                        : [{ value: "default", label: "默认" }],
                  onSelect: (option: SelectOption) => {
                    if (option.value === "__connect__") {
                      setSelectorOpen("connect");
                      return;
                    }
                    setSelectorOpen(undefined);
                    if (kind === "theme") {
                      const next = option.value as TuiThemeName;
                      setThemeName(next);
                      theme.setActive(next);
                    } else if (kind === "model") {
                      setActiveModel(option.value);
                      props.onModelChange?.(option.value);
                    }
                  },
                  onCancel: () => setSelectorOpen(undefined),
                };
                if (kind === "connect") {
                  return (
                    <ConnectDialog
                      initialUrl={props.connection?.url}
                      initialKey={props.connection?.key}
                      onSubmit={(url, key) => {
                        setSelectorOpen(undefined);
                        props.onConnect?.(url, key);
                      }}
                      onCancel={() => setSelectorOpen(undefined)}
                    />
                  );
                }
                if (kind === "model") {
                  const models = props.modelList ?? [];
                  if (models.length === 0) {
                    return (
                      <SelectDialog
                        title="选择模型"
                        options={[{ value: "__connect__", label: "未配置 API — 请用 /connect 连接" }]}
                        onSelect={() => setSelectorOpen("connect")}
                        onCancel={() => setSelectorOpen(undefined)}
                      />
                    );
                  }
                  return (
                    <ModelPicker
                      models={models}
                      current={props.currentModel ?? activeModel()}
                      effort={props.reasoningEffort ?? effort()}
                      onSelect={(value) => {
                        setActiveModel(value);
                        setSelectorOpen(undefined);
                        props.onModelChange?.(value);
                      }}
                      onEffort={(next) => {
                        setEffort(next);
                        props.onEffortChange?.(next);
                      }}
                      onCancel={() => setSelectorOpen(undefined)}
                    />
                  );
                }
                if (kind === "theme") return <ThemeSelector {...shared} title={SELECTOR_TITLES[kind]} />;
                return <SettingsSelector {...shared} title={SELECTOR_TITLES[kind]} />;
              }}
            </Show>
            <BoundSlot name="footer" mode="replace">
              <FooterBridge
                source={props.source}
                model={props.currentModel ?? activeModel() ?? props.model ?? "zeta"}
                pwd={props.cwd}
                provider={props.provider}
                modelId={props.currentModel ?? activeModel() ?? props.model}
                telemetry={props.telemetry}
              />
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
      <Show when={props.approvalUi !== undefined}>
        {(channel: () => ApprovalUiChannel) => <ApprovalOverlay channel={channel()} />}
      </Show>
      <Show when={helpOpen()}>
        <HelpOverlay onClose={() => setHelpOpen(false)} />
      </Show>
      <Show when={paletteOpen()}>
        <CommandPaletteView
          commands={paletteCommands()}
          onRun={(command: Command) => {
            setPaletteOpen(false);
            submit(`/${command.id}`);
          }}
          onCancel={() => setPaletteOpen(false)}
        />
      </Show>
    </>
  );
}

export function createTuiSubmitHandler(options: RuntimeTuiOptions) {
  return (text: string, mode?: SubmitMode): boolean | void | Promise<boolean | void> => {
    if (options.commands && text.startsWith("/")) return options.commands(text);
    if (options.onSubmit === undefined) return false;
    return options.onSubmit(text, mode) ?? true;
  };
}

const CONTROL_ACTIONS: ReadonlySet<string> = new Set<ControlAction>([
  "prompt", "continue", "steer", "followUp", "abort", "reset",
]);

/** 注入 backend 时由它接管完整生命周期：不再创建默认原生渲染器。 */
async function renderTuiWithBackend(
  options: RuntimeTuiOptions,
  backend: RendererBackend,
): Promise<RuntimeTuiHandle> {
  const keymap = createRuntimeKeymap({ bindings: options.keyBindings });
  const approvalUi = options.approvalUi ?? createApprovalUiChannel();
  let size: BackendSize = {
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  };
  const messages: RuntimeMessage[] = [...(options.messages ?? [])];
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let destroyed = false;

  const renderFrame = (): void => {
    backend.render({
      width: size.width,
      height: size.height,
      lines: messages.map(messageLine),
    });
  };

  await backend.mount({
    ...size,
    screenMode: resolveDualMode(options.mode).screenMode,
    useKittyKeyboard: true,
  });
  const offEvent = backend.event((event) => {
    if (destroyed) return;
    if (event.type === "resize") {
      size = event.size;
      renderFrame();
      return;
    }
    if (event.type === "paste") {
      void options.onSubmit?.(event.text);
      return;
    }
    if (event.key.eventType === "release" || event.key.defaultPrevented) return;
    const action = keymap.resolve(resolveKittyCombo(event.key))?.action;
    if (action === undefined) return;
    if (action === "exit") {
      event.key.preventDefault();
      event.key.stopPropagation();
      options.onExit?.();
      resolveClosed();
      return;
    }
    if (action === "confirm") {
      event.key.preventDefault();
      if (approvalUi.pending() !== undefined) approvalUi.respond("allowed-once");
      return;
    }
    if (action === "copy-selection") {
      event.key.preventDefault();
      backend.clipboard.copy(messages.map((message) => String(message.content)).join("\n"));
      return;
    }
    if (CONTROL_ACTIONS.has(action)) {
      event.key.preventDefault();
      const controlAction = action as ControlAction;
      if (options.protocol !== undefined) {
        void options.protocol.control.dispatch(encodeControlFrame({ action: controlAction }));
      } else if (controlAction === "abort") {
        options.onAbort?.();
      }
    }
  });
  renderFrame();

  return {
    approvalUi,
    appendMessage(message) {
      messages.push(message);
      renderFrame();
    },
    setModels() {},
    setModelOptions() {},
    setModel() {},
    waitForExit() {
      return closed;
    },
    getSignals() {
      return undefined;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      offEvent();
      backend.destroy();
      resolveClosed();
    },
  };
}

export async function renderTui(options: RuntimeTuiOptions = {}): Promise<RuntimeTuiHandle> {
  if (options.backend !== undefined) return renderTuiWithBackend(options, options.backend);
  const screenMode = resolveDualMode(options.mode).screenMode;
  const renderer = new CliRenderer(
    process.stdin,
    process.stdout,
    process.stdout.columns || 80,
    process.stdout.rows || 24,
    {
      screenMode,
      exitOnCtrlC: false,
      useMouse: true,
      clearOnShutdown: false,
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    },
  );
  // 关键：构造函数不会进入备用屏/原始模式，必须显式 setupTerminal。
  try {
    await renderer.setupTerminal();
  } catch (error) {
    renderer.destroy();
    await renderer.closed.catch(() => {});
    throw error;
  }

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let push: (message: RuntimeMessage) => void = () => {};
  let editorHandle: EditorHandle | undefined;
  let destroyed = false;
  // 响应式模型状态：宿主拉取 /v1/models 后经 handle.setModelOptions/setModel 刷新 UI。
  const [modelList, setModelList] = createSignal<readonly RuntimeModelOption[]>([]);
  const [currentModel, setCurrentModel] = createSignal<string | undefined>(options.model);

  // 真实遥测：分支/会话/定价来自宿主，token/成本由 agent 的 message_end usage 事件累计。
  const [telemetry, setTelemetry] = createSignal<AgentUsageTelemetry | undefined>(undefined);
  const baseTelemetry = initialTelemetry({
    ...options.telemetry,
    cwd: options.telemetry?.cwd ?? options.cwd,
  });
  const tracker = createUsageTracker({
    pricing: baseTelemetry.pricing,
    initialUsage: baseTelemetry.initialUsage,
  });
  const publishUsage = (): void => {
    const snapshot = tracker.snapshot();
    setTelemetry({
      ...baseTelemetry,
      metrics: snapshot.metrics,
      usedTokens: snapshot.usedTokens,
    });
  };
  publishUsage();
  const releaseUsage = options.source?.subscribe((event) => {
    // tracker 只在 message_end 记账；其他事件不触发无谓的 footer 重绘。
    if (event.type !== "message_end") return;
    tracker.consume(event);
    publishUsage();
  });

  const signals: AgentSignals | undefined = options.source
    ? createAgentSignals(options.source)
    : undefined;
  const osc = createOscReporter((sequence) => process.stdout.write(sequence));
  const releaseOsc = signals
    ? createOscBridge(signals, (sequence) => process.stdout.write(sequence))
    : undefined;

  const onSubmit = createTuiSubmitHandler(options);
  const approvalUi = options.approvalUi ?? createApprovalUiChannel();

  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    releaseUsage?.();
    releaseOsc?.();
    signals?.dispose();
    resolveClosed();
  };

  const exit = (): void => {
    if (destroyed) return;
    cleanup();
    renderer.destroy();
  };

  // 渲染器自行关闭（原生会话失败/退出信号）时也走同一收尾路径，
  // 避免宿主 waitForExit() 永久挂起。
  void renderer.closed.then(cleanup, cleanup);

  try {
    await openTuiRender(
      () => (
        <ThemeProvider initial={options.theme ?? "dark"}>
          <OscProvider reporter={osc}>
            <ZetaApp
            title={options.title ?? "zeta"}
            messages={options.messages ?? []}
            source={options.source}
            onPush={(sink) => {
              push = sink;
            }}
            onSubmit={onSubmit}
            onSubmitError={options.onSubmitError}
            onEditorHandle={(handle) => { editorHandle = handle; }}
            onCommand={options.onCommand}
            onAbort={options.onAbort}
            commandList={options.commandList}
            commandCatalog={options.commandCatalog}
            plugins={options.plugins}
            cwd={options.cwd}
            model={options.model}
            models={options.models}
            modelList={modelList()}
            currentModel={currentModel()}
            reasoningEffort={options.reasoningEffort}
            onEffortChange={options.onEffortChange}
            onNewSession={options.onNewSession}
            onConnect={options.onConnect}
            connection={options.connection}
            onModelChange={options.onModelChange}
            provider={options.provider}
            resources={options.resources}
            theme={options.theme}
            telemetry={telemetry()}
            keyBindings={options.keyBindings}
            approvalUi={approvalUi}
            onExit={() => {
              options.onExit?.();
              exit();
            }}
          />
          </OscProvider>
        </ThemeProvider>
      ),
      renderer,
    );
  } catch (error) {
    exit();
    await renderer.closed.catch(() => {});
    throw error;
  }

  return {
    approvalUi,
    appendMessage(message) {
      push(message);
    },
    setModels(models) {
      setModelList(models.map((value) => ({ value })));
    },
    setModelOptions(options) {
      setModelList(options);
    },
    setModel(model) {
      setCurrentModel(model);
    },
    waitForExit() {
      return closed;
    },
    restoreDraft(text) {
      if ((editorHandle?.value() ?? "").trim().length === 0) editorHandle?.setValue(text);
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
