export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface RuntimeTuiOptions {
  readonly title?: string;
  readonly messages?: readonly RuntimeMessage[];
  readonly onSubmit?: (text: string) => void | Promise<void>;
  readonly onExit?: () => void;
}

export interface RuntimeTuiHandle {
  appendMessage(message: RuntimeMessage): void;
  waitForExit(): Promise<void>;
  destroy(): Promise<void>;
}
