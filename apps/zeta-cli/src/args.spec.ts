import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("CLI 参数解析", () => {
  test("无参数默认 TUI 模式", () => {
    expect(parseArgs([])).toEqual({
      mode: "tui",
      prompt: undefined,
      help: false,
      version: false,
    });
  });

  test("--headless 走 headless（print）模式并携带提示词", () => {
    expect(parseArgs(["--headless", "hello", "world"])).toEqual({
      mode: "headless",
      prompt: "hello world",
      help: false,
      version: false,
    });
  });

  test("--print/--json/--rpc 选择对应模式", () => {
    expect(parseArgs(["--print", "x"]).mode).toBe("headless");
    expect(parseArgs(["--json", "x"]).mode).toBe("json");
    expect(parseArgs(["--rpc", "x"]).mode).toBe("rpc");
  });

  test("--help 与 --version 标志", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("未知选项抛错", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("UNKNOWN_OPTION");
  });
});
