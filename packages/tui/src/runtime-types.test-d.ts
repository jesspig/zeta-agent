import type { AgentSignals } from "./signal";
import type { RuntimeTuiHandle, RuntimeTuiOptions } from "./runtime-types";

declare const source: import("./signal").EventSource;
declare const commands: (command: string) => void | Promise<void>;

const options: RuntimeTuiOptions = {
  title: "zeta",
  messages: [{ role: "user", content: "hi" }],
  onSubmit: (text) => void text,
  onExit: () => void 0,
  source,
  commands,
  theme: "system",
};

const handle: RuntimeTuiHandle = {} as RuntimeTuiHandle;
const signals: AgentSignals | undefined = handle.getSignals();
void signals;
void options;
