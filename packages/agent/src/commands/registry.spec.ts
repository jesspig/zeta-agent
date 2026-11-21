import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMAND_NAMES,
  createCommandRegistry,
  parseCommand,
} from "./registry";

describe("T-14 Slash 命令解析", () => {
  test("常见命令清单齐全", () => {
    for (const name of [
      "settings", "model", "thinking", "new", "resume", "name", "session", "tree",
      "fork", "clone", "compact", "copy", "export", "share", "trust", "mcp",
      "reload", "hotkeys", "quit",
    ]) {
      expect(BUILTIN_COMMAND_NAMES).toContain(name);
    }
  });

  test("parseCommand 解析 /name 与 /name 参数（空格与冒号两种形式）", () => {
    expect(parseCommand("/model")).toEqual({ name: "model", args: [], raw: "/model" });
    expect(parseCommand("/model gpt-4o")).toEqual({
      name: "model",
      args: ["gpt-4o"],
      raw: "/model gpt-4o",
    });
    expect(parseCommand("/model:gpt-4o")).toEqual({
      name: "model",
      args: ["gpt-4o"],
      raw: "/model:gpt-4o",
    });
  });

  test("parseCommand 对非斜杠输入返回 undefined", () => {
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand("")).toBeUndefined();
  });
});

describe("T-14 Slash 命令注册表", () => {
  test("内置命令可执行并返回 ok", async () => {
    const registry = createCommandRegistry();
    const result = await registry.execute("/model gpt-4o");
    expect(result.ok).toBe(true);
    expect(result.name).toBe("model");
    expect(result.args).toEqual(["gpt-4o"]);
  });

  test("未知命令返回 UNKNOWN_COMMAND", async () => {
    const registry = createCommandRegistry();
    const result = await registry.execute("/definitely-not-a-command");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("UNKNOWN_COMMAND");
  });

  test("扩展可注册自定义命令，覆盖同名内置命令", async () => {
    const registry = createCommandRegistry();
    const calls: string[] = [];

    registry.register({
      name: "deploy",
      description: "部署",
      category: "custom",
      handler: ({ args }) => { calls.push(args.join(",")); },
    });
    const custom = await registry.execute("/deploy now prod");
    expect(custom.ok).toBe(true);
    expect(calls).toEqual(["now,prod"]);

    registry.register({
      name: "model",
      description: "自定义模型",
      category: "custom",
      handler: ({ args }) => { calls.push(`custom:${args[0]}`); },
    });
    const override = await registry.execute("/model x");
    expect(override.ok).toBe(true);
    expect(calls).toContain("custom:x");
  });

  test("list 含全部内置命令与扩展命令，且支持 disposer 撤销", () => {
    const registry = createCommandRegistry();
    expect(registry.list().length).toBeGreaterThanOrEqual(BUILTIN_COMMAND_NAMES.length);

    const stop = registry.register({
      name: "temp",
      description: "临时",
      category: "custom",
      handler: () => {},
    });
    expect(registry.list().map((c) => c.name)).toContain("temp");
    stop();
    expect(registry.list().map((c) => c.name)).not.toContain("temp");
  });
});
