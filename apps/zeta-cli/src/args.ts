import { resolveAssemblyProfile, type AssemblyProfile } from "@zeta-agent/agent";

export type CliMode = "tui" | "headless" | "json" | "rpc";

export interface CliArgs {
  readonly mode: CliMode;
  readonly prompt?: string;
  readonly help: boolean;
  readonly version: boolean;
  /** 产品 profile；local-safe 默认，local-full 显式 opt-in。 */
  readonly profile: AssemblyProfile;
  /** 打印统一装配的能力诊断后退出（不加载 TUI、不发模型请求）。 */
  readonly capabilities: boolean;
  /** 插件热重载目录；可重复指定，变更后不重启进程即生效。 */
  readonly watchDirs: readonly string[];
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
  let capabilities = false;
  let profile: string | undefined;
  const watchDirs: string[] = [];
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--capabilities") {
      capabilities = true;
      continue;
    }
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) throw new Error("PROFILE_VALUE_REQUIRED");
      profile = value;
      index += 1;
      continue;
    }
    if (arg === "--watch") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) throw new Error("WATCH_DIR_REQUIRED");
      watchDirs.push(value);
      index += 1;
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
    profile: resolveAssemblyProfile(profile),
    capabilities,
    watchDirs,
  };
}
