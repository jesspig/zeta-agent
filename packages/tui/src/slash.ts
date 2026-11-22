import { fuzzyScore } from "./completion";

/** 斜杠命令的补全条目（名称、说明与参数提示）。 */
export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

export interface SlashQuery {
  /** 不含前导 "/" 的查询串。 */
  readonly prefix: string;
}

/**
 * 命令候选触发条件（与目标终端 UI 一致）：
 * 单行输入、以 "/" 开头、尚未出现空格，且第一个 "/" 之后没有路径分隔符。
 */
export function slashQuery(text: string): SlashQuery | null {
  if (text.length === 0 || !text.startsWith("/")) return null;
  if (text.includes("\n")) return null;
  if (/\s/.test(text)) return null;
  if (text.slice(1).includes("/")) return null;
  return { prefix: text.slice(1) };
}

/** 模糊过滤命令：前缀命中优先，其次按分数降序。 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  prefix: string,
): readonly SlashCommand[] {
  const query = prefix.toLowerCase();
  if (query.length === 0) return commands;
  return commands
    .map((command) => ({
      command,
      score: fuzzyScore(query, command.name.toLowerCase()),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command);
}

/** 选中一条命令后的输入框文本：`/name `。 */
export function applySlashCommand(item: Pick<SlashCommand, "name">): string {
  return `/${item.name} `;
}

/** 候选行的主列文本（补全项展示用）。 */
export function slashCommandLabel(command: SlashCommand): string {
  return `/${command.name}`;
}

/** 候选行的说明：argumentHint 优先，用 " — " 连接描述。 */
export function slashCommandDescription(command: SlashCommand): string | undefined {
  const hint = command.argumentHint;
  const description = command.description ?? "";
  if (hint !== undefined && hint.length > 0) {
    return description.length > 0 ? `${hint} — ${description}` : hint;
  }
  return description.length > 0 ? description : undefined;
}
