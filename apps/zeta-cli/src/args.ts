export type CliMode = "tui" | "headless" | "json" | "rpc";

export interface CliArgs {
  readonly mode: CliMode;
  readonly prompt?: string;
  readonly help: boolean;
  readonly version: boolean;
}

const MODE_FLAGS: Readonly<Record<string, CliMode>> = {
  "--headless": "headless",
  "--print": "headless",
  "--json": "json",
  "--rpc": "rpc",
};

export function parseArgs(argv: readonly string[]): CliArgs {
  let mode: CliMode = "tui";
  let help = false;
  let version = false;
  const promptParts: string[] = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MODE_FLAGS, arg)) {
      mode = MODE_FLAGS[arg] as CliMode;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`UNKNOWN_OPTION: ${arg}`);
    }
    promptParts.push(arg);
  }

  return {
    mode,
    prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
    help,
    version,
  };
}
