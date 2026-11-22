import type { AgentSignals, EventSource } from "./signal";
import type { SolidPlugin } from "./slots-native";
import type { ZetaNativeSlots } from "./slots-native";
import type { SlashCommand } from "./slash";

export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
}

export type CommandHandler = (command: string) => void | Promise<void>;
export type TuiThemeName = "system" | "dark" | "light";

export interface RuntimeResources {
  readonly models?: readonly string[];
  readonly prompts?: readonly string[];
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
}

export interface RuntimeTuiOptions {
  readonly title?: string;
  readonly messages?: readonly RuntimeMessage[];
  readonly onSubmit?: (text: string) => void | Promise<void>;
  readonly onExit?: () => void;
  /** Esc：中止当前运行。 */
  readonly onAbort?: () => void;
  readonly source?: EventSource;
  /** 非本地命令的兜底处理（以 "/" 开头）。 */
  readonly commands?: CommandHandler;
  /** 本地命令未命中时的处理器。 */
  readonly onCommand?: (text: string) => void | Promise<void>;
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
  readonly resources?: RuntimeResources;
}

export interface RuntimeTuiHandle {
  appendMessage(message: RuntimeMessage): void;
  waitForExit(): Promise<void>;
  destroy(): Promise<void>;
  getSignals(): AgentSignals | undefined;
}
