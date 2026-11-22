import { describe, expect, test } from "bun:test";
import {
  applySlashCommand,
  filterSlashCommands,
  slashCommandDescription,
  slashCommandLabel,
  slashQuery,
  type SlashCommand,
} from "./slash";

const commands: readonly SlashCommand[] = [
  { name: "model", description: "选择模型", argumentHint: "<provider/model>" },
  { name: "theme", description: "切换主题" },
  { name: "compact", description: "压缩会话上下文" },
  { name: "help", description: "显示帮助" },
];

describe("斜杠命令候选", () => {
  test("只在单行、行首、无空格时触发", () => {
    expect(slashQuery("/")).toEqual({ prefix: "" });
    expect(slashQuery("/mo")).toEqual({ prefix: "mo" });
    expect(slashQuery(" /mo")).toBeNull();
    expect(slashQuery("/model x")).toBeNull();
    expect(slashQuery("/a/b")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });

  test("模糊过滤：前缀命中优先，无命中返回空", () => {
    expect(filterSlashCommands(commands, "").map((item) => item.name)).toEqual(["model", "theme", "compact", "help"]);
    expect(filterSlashCommands(commands, "mo").map((item) => item.name)).toEqual(["model"]);
    expect(filterSlashCommands(commands, "co").map((item) => item.name)).toEqual(["compact"]);
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });

  test("选中后写入 `/name `，描述含参数提示", () => {
    expect(applySlashCommand({ name: "model" })).toBe("/model ");
    expect(slashCommandLabel(commands[0]!)).toBe("/model");
    expect(slashCommandDescription(commands[0]!)).toBe("<provider/model> — 选择模型");
    expect(slashCommandDescription(commands[1]!)).toBe("切换主题");
  });
});
