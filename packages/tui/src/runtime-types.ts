import type { AgentSignals, EventSource } from "./signal";

export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
}

export type CommandHandler = (command: string) => void | Promise<void>;
export type TuiThemeName = "system" | "dark" | "light";

export interface RuntimeTuiOptions {
  readonly title?: string;
  readonly messages?: readonly RuntimeMessage[];
  readonly onSubmit?: (text: string) => void | Promise<void>;
  readonly onExit?: () => void;
  readonly source?: EventSource;
  readonly commands?: CommandHandler;
  readonly commandList?: readonly { readonly id: string; readonly title: string }[];
  readonly theme?: TuiThemeName;
  readonly mode?: "regular" | "fullscreen";
}

export interface RuntimeTuiHandle {
  appendMessage(message: RuntimeMessage): void;
  waitForExit(): Promise<void>;
  destroy(): Promise<void>;
  getSignals(): AgentSignals | undefined;
}
