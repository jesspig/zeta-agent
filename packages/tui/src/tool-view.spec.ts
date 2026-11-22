import { describe, expect, test } from "bun:test";
import { presentTool, resultToText, displayPath } from "./tool-view";
import type { TimelineToolEntry } from "./timeline";

function entry(overrides: Partial<TimelineToolEntry> & Pick<TimelineToolEntry, "name">): TimelineToolEntry {
  return {
    kind: "tool",
    id: "t1",
    args: {},
    status: "done",
    ...overrides,
  };
}

function textOf(line: readonly { readonly text: string }[]): string {
  return line.map((run) => run.text).join("");
}

describe("工具呈现（逐工具）", () => {
  test("read 折叠时只显示标题，展开后才展示内容", () => {
    const base = entry({ name: "read", args: { path: "/repo/src/a.ts" }, result: { ok: true, content: "line1\nline2" } });
    const collapsed = presentTool(base, { cwd: "/repo" });
    expect(textOf(collapsed.header)).toBe("read src/a.ts");
    expect(collapsed.body).toHaveLength(0);

    const expanded = presentTool(base, { cwd: "/repo", expanded: true });
    expect(expanded.body.length).toBe(2);
    expect(textOf(expanded.body[0]!)).toBe("line1");
  });

  test("bash 折叠保留最后 5 行并提示更早行数", () => {
    const output = Array.from({ length: 8 }, (_, index) => `l${index + 1}`).join("\n");
    const view = presentTool(entry({ name: "bash", args: { command: "ls" }, result: { ok: true, stdout: output } }));
    expect(textOf(view.header)).toBe("bash ls");
    expect(view.body.map(textOf)).toEqual(["l4", "l5", "l6", "l7", "l8", "... (3 earlier lines, ctrl+o to expand)"]);
  });

  test("write 折叠预览内容 10 行，edit 始终展示完整 diff", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const write = presentTool(entry({ name: "write", args: { path: "a.txt", content } }));
    expect(textOf(write.header)).toBe("write a.txt");
    expect(write.body.length).toBe(11); // 10 行 + 折叠提示
    expect(textOf(write.body[10]!)).toContain("2 more lines");

    const edit = presentTool(
      entry({ name: "edit", args: { path: "a.ts", from: "old", to: "new" } }),
    );
    const lines = edit.body.map(textOf);
    expect(lines).toContain("- old");
    expect(lines).toContain("+ new");
  });

  test("grep/find/ls 使用各自预览上限，错误与耗时进入尾注", () => {
    const matches = Array.from({ length: 20 }, (_, index) => `${index + 1}: hit`).join("\n");
    const grep = presentTool(entry({ name: "grep", args: { path: "a.ts", pattern: "hit" }, result: matches }));
    expect(grep.body.length).toBe(16); // 15 行 + 提示
    expect(textOf(grep.body[15]!)).toContain("5 more lines");

    const find = presentTool(entry({ name: "find", args: { path: ".", pattern: "a" }, result: matches }));
    expect(find.body.length).toBe(20);

    const failed = presentTool(
      entry({ name: "bash", args: { command: "x" }, status: "error", result: "boom", durationMs: 1200 }),
    );
    expect(failed.note === undefined ? "" : textOf(failed.note)).toContain("Failed");
    expect(failed.note === undefined ? "" : textOf(failed.note)).toContain("1.2s");
  });

  test("结果对象归一化与相对路径", () => {
    expect(resultToText({ ok: true, entries: [{ name: "src", type: "directory" }] })).toBe("src/");
    expect(resultToText({ ok: true, matches: [{ line: 3, text: "x" }] })).toBe("3: x");
    expect(resultToText({ ok: false, error: "TOOL_INPUT_INVALID" })).toBe("TOOL_INPUT_INVALID");
    expect(displayPath("C:\\repo\\a.ts", "C:\\repo")).toBe("a.ts");
  });
});
