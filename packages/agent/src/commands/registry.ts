/** 常见 Slash 命令清单（模型/会话/导出/运行类）。 */
export const BUILTIN_COMMAND_NAMES: readonly string[] = Object.freeze([
  "settings",
  "model",
  "thinking",
  "new",
  "resume",
  "name",
  "session",
  "tree",
  "fork",
  "clone",
  "compact",
  "copy",
  "export",
  "share",
  "trust",
  "mcp",
  "reload",
  "hotkeys",
  "quit",
]);

export type CommandCategory = "model" | "session" | "export" | "runtime" | "custom";

/** 命令规格（供面板/注册表共用）。 */
export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly category: CommandCategory;
  readonly handler: (context: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  readonly name: string;
  readonly args: readonly string[];
  readonly raw: string;
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly raw: string;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly name: string;
  readonly args: readonly string[];
  readonly error?: string;
}

export interface CommandRegistry {
  /** 解析并执行一条命令输入（以 / 开头）。 */
  execute(input: string): Promise<CommandResult>;
  /** 注册自定义命令，返回幂等 disposer；可覆盖同名命令。 */
  register(spec: CommandSpec): () => void;
  /** 当前全部命令规格。 */
  list(): readonly CommandSpec[];
}

const CATEGORY_BY_NAME: Readonly<Record<string, CommandCategory>> = {
  settings: "runtime",
  model: "model",
  thinking: "model",
  new: "session",
  resume: "session",
  name: "session",
  session: "session",
  tree: "session",
  fork: "session",
  clone: "session",
  compact: "session",
  copy: "export",
  export: "export",
  share: "export",
  trust: "runtime",
  mcp: "runtime",
  reload: "runtime",
  hotkeys: "runtime",
  quit: "runtime",
};

const DESCRIPTION_BY_NAME: Readonly<Record<string, string>> = {
  settings: "打开设置",
  model: "切换模型",
  thinking: "设置思考级别",
  new: "新建会话",
  resume: "恢复会话",
  name: "命名会话",
  session: "查看会话信息",
  tree: "显示会话树",
  fork: "分叉会话",
  clone: "克隆会话",
  compact: "压缩会话",
  copy: "复制会话内容",
  export: "导出会话",
  share: "分享会话",
  trust: "管理项目信任",
  mcp: "管理 MCP 服务器",
  reload: "热重载扩展",
  hotkeys: "查看快捷键",
  quit: "退出",
};

/** 解析斜杠命令：支持 `/name arg1 arg2` 与 `/name:arg1` 两种形式。 */
export function parseCommand(input: string): ParsedCommand | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1);
  let name: string;
  let rest: string;
  const colon = body.indexOf(":");
  if (colon >= 0) {
    name = body.slice(0, colon);
    rest = body.slice(colon + 1);
  } else {
    const space = body.search(/\s/);
    if (space < 0) {
      name = body;
      rest = "";
    } else {
      name = body.slice(0, space);
      rest = body.slice(space + 1);
    }
  }
  if (name.length === 0) return undefined;
  const args = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/);
  return { name, args, raw: trimmed };
}

/** 创建统一命令注册表：内置命令 + 扩展自定义命令。 */
export function createCommandRegistry(): CommandRegistry {
  const specs = new Map<string, CommandSpec>();
  for (const name of BUILTIN_COMMAND_NAMES) {
    specs.set(name, {
      name,
      description: DESCRIPTION_BY_NAME[name] ?? name,
      category: CATEGORY_BY_NAME[name] ?? "runtime",
      handler: () => {},
    });
  }

  return {
    async execute(input) {
      const parsed = parseCommand(input);
      if (parsed === undefined) {
        return { ok: false, name: "", args: [], error: "INVALID_COMMAND" };
      }
      const spec = specs.get(parsed.name);
      if (spec === undefined) {
        return { ok: false, name: parsed.name, args: parsed.args, error: "UNKNOWN_COMMAND" };
      }
      await spec.handler({ name: parsed.name, args: parsed.args, raw: parsed.raw });
      return { ok: true, name: parsed.name, args: parsed.args };
    },
    register(spec) {
      if (typeof spec?.name !== "string" || spec.name.length === 0) {
        throw new Error("command.register: name required");
      }
      specs.set(spec.name, spec);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (specs.get(spec.name) === spec) specs.delete(spec.name);
      };
    },
    list() {
      return [...specs.values()];
    },
  };
}
