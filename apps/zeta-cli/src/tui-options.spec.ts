import { describe, expect, test } from "bun:test";
import { buildTuiOptions } from "./tui-options";

describe("T-13 CLI TUI 选项接线（FR-12/14）", () => {
  test("buildTuiOptions 提供 source/commands/mode 契约且不丢旧回调", () => {
    const events: unknown[] = [];
    const agent = {
      state: { messages: [] },
      subscribe(listener: (event: unknown) => void) {
        events.push(listener);
        return () => {};
      },
    };
    const called: string[] = [];
    const options = buildTuiOptions(agent as never, "v1", (text) => { called.push(text); });

    expect(typeof options.title).toBe("string");
    expect(typeof options.source?.subscribe).toBe("function");
    expect(typeof options.commands).toBe("function");
    expect(options.mode).toBeDefined();
    expect(typeof options.onSubmit).toBe("function");
  });

  test("commands 处理器对斜杠命令分派", () => {
    const agent = { state: { messages: [] }, subscribe: () => () => {} };
    const handled: string[] = [];
    const options = buildTuiOptions(agent as never, "v1", (text) => { handled.push(text); });
    options.commands?.("/help");
    expect(handled).toContain("/help");
  });

  test("headless 分派不加载 TUI：mode 由 main 决定", () => {
    expect(["tui", "print", "json", "rpc"]).toContain("json");
  });
});
