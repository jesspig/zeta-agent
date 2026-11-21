import { describe, expect, test } from "bun:test";
import { createHistory } from "./editor-history";
import {
  foldBracketedPaste,
  graphemeSafeTruncate,
  killRing,
  undoStack,
} from "./paste";
import { createEditorState } from "./components/editor";

describe("T-08 编辑器历史与草稿（IF-10）", () => {
  test("历史上翻/下翻与草稿恢复", () => {
    const history = createHistory(3);
    history.push("one");
    history.push("two");
    history.push("three");

    expect(history.previous("draft-current")).toBe("three");
    expect(history.previous()).toBe("two");
    expect(history.next()).toBe("three");
    expect(history.next()).toBeNull();

    history.push("four");
    expect(history.size).toBe(3);
    expect(history.entries()).toEqual(["two", "three", "four"]);

    history.previous("new-draft");
    expect(history.currentDraft()).toBe("new-draft");
    history.next();
    expect(history.currentDraft()).toBeNull();
  });

  test("历史容量上限与重复折叠", () => {
    const history = createHistory(2);
    history.push("a");
    history.push("a");
    history.push("b");
    expect(history.entries()).toEqual(["a", "b"]);
  });
});

describe("T-08 CJK/grapheme、kill-ring、undo、paste 折叠", () => {
  test("graphemeSafeTruncate 不切断 CJK 与 emoji 组合", () => {
    expect(graphemeSafeTruncate("你好世界abc", 4)).toBe("你好世界");
    expect(graphemeSafeTruncate("a👍🏽b", 2)).toBe("a👍🏽");
    expect(graphemeSafeTruncate("abc", 10)).toBe("abc");
  });

  test("killRing yank/yank-pop 与 undo", () => {
    const ring = killRing();
    ring.kill("alpha");
    ring.kill("beta");
    expect(ring.yank()).toBe("beta");
    expect(ring.yankPop()).toBe("alpha");

    const undo = undoStack();
    undo.record("");
    undo.record("a");
    undo.record("ab");
    expect(undo.undo()).toBe("a");
    expect(undo.redo()).toBe("ab");
  });

  test("bracketed paste 折叠为原子占位块", () => {
    const result = foldBracketedPaste("before \x1b[200~line1\nline2\x1b[201~ after");
    expect(result.text).toContain("[paste #1]");
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.content).toContain("line1");
  });

  test("编辑器状态：上翻历史、粘贴折叠、CJK 安全、kill/undo", () => {
    const editor = createEditorState();
    editor.commit("你好世界abc");
    expect(editor.graphemeSafeTruncate(editor.value(), 2)).toBe("你好");
    editor.handlePaste("\x1b[200~paste-body\x1b[201~");
    expect(editor.value()).toContain("[paste #1]");
    expect(editor.pasted()).toBe(1);
    const submitted = editor.submit();
    expect(submitted).toContain("[paste #1]");
    expect(editor.value()).toBe("");
    editor.commit("second");
    expect(editor.handleKey({ name: "up" } as never)).toBe(true);
    expect(editor.value()).toContain("[paste #1]");
  });
});
