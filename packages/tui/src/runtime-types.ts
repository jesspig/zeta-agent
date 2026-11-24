import type { AgentSignals, EventSource } from "./signal";
import type { SolidPlugin } from "./slots-native";
import type { ZetaNativeSlots } from "./slots-native";
import type { SlashCommand } from "./slash";
import type { SubmitMode } from "./components/editor";
import type { AgentUsageTelemetry } from "./telemetry-types";

export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
}

export type CommandHandler = (command: string) => boolean | void | Promise<boolean | void>;
export type TuiThemeName = "system" | "dark" | "light";

/** 模型选项：分列元数据供多列对齐展示。 */
export interface RuntimeModelOption {
  readonly value: string;
  readonly name?: string;
  readonly context?: string;
  readonly price?: string;
  readonly effort?: readonly string[];
  readonly reasoning?: boolean;
  readonly vision?: boolean;
  readonly group?: string;
  /** 兼容旧调用：单行描述。 */
  readonly label?: string;
  readonly description?: string;
}

export interface RuntimeResources {
  readonly models?: readonly string[];
  readonly prompts?: readonly string[];
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
}

export interface RuntimeTuiOptions {
  readonly title?: string;
  readonly messages?: readonly RuntimeMessage[];
  readonly onSubmit?: (text: string, mode?: SubmitMode) => boolean | void | Promise<boolean | void>;
  readonly onSubmitError?: (error: unknown) => void;
  readonly onExit?: () => void;
  /** Esc：中止当前运行。 */
  readonly onAbort?: () => void;
  readonly source?: EventSource;
  /** 非本地命令的兜底处理（以 "/" 开头）。 */
  readonly commands?: CommandHandler;
  /** 本地命令未命中时的处理器。 */
  readonly onCommand?: (text: string) => boolean | void | Promise<boolean | void>;
  readonly commandList?: readonly { readonly id: string; readonly title: string }[];
  /** 斜杠命令候选来源。 */
  readonly commandCatalog?: readonly SlashCommand[];
  readonly plugins?: readonly SolidPlugin<ZetaNativeSlots>[];
  readonly theme?: TuiThemeName;
  readonly mode?: "regular" | "fullscreen";
  /** 工作目录：工具路径折叠与 footer 展示。 */
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly models?: readonly string[];
  /** 选择模型后回调（宿主据此切换实际 streamFn）。 */
  readonly onModelChange?: (model: string) => void;
  /** 连接对话框提交回调（宿主设置连接并拉取模型）。 */
  readonly onConnect?: (url: string, key: string) => void;
  /** 连接对话框初始值（环境变量兜底）。 */
  readonly connection?: { readonly url?: string; readonly key?: string };
  /** 思考强度档位与变更回调。 */
  readonly reasoningEffort?: string;
  readonly onEffortChange?: (effort: string) => void;
  /** /new：宿主执行真实会话替换；未提供时保持旧的纯视图行为。 */
  readonly onNewSession?: () => void | Promise<void>;
  readonly resources?: RuntimeResources;
  /** 真实遥测（token/成本/分支/会话）：运行时从事件源补齐 token，再交给 footer。 */
  readonly telemetry?: AgentUsageTelemetry;
}

export interface RuntimeTuiHandle {
  appendMessage(message: RuntimeMessage): void;
  /** 异步刷新可选模型 id 列表（如拉取 /v1/models 成功后）。 */
  setModels(models: readonly string[]): void;
  /** 异步刷新带元数据的模型选项。 */
  setModelOptions(options: readonly RuntimeModelOption[]): void;
  /** 异步更新当前模型显示。 */
  setModel(model: string): void;
  readonly restoreDraft?: (text: string) => void;
  waitForExit(): Promise<void>;
  destroy(): Promise<void>;
  getSignals(): AgentSignals | undefined;
}
