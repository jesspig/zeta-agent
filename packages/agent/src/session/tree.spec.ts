import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecap, type SemanticRecap } from "@zeta-agent/agent-framework";
import {
  createSessionTree,
  parseJsonl,
  serializeJsonl,
  type JsonlEntry,
} from "./tree";

/** 取条目的消息内容；recap 条目没有 message。 */
function contentOf(entry: JsonlEntry): unknown {
  return entry.kind === "message" ? entry.message.content : undefined;
}

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-session-tree-"));
  dirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function recap(text: string): SemanticRecap {
  return createRecap({
    objective: text,
    establishedFacts: [],
    appliedChanges: [],
    verification: [],
    deadEnds: [],
    remainingPlan: [],
  });
}

describe("T-16 JSONL 序列化", () => {
  test("serializeJsonl / parseJsonl 往返保留 id/parentId/role/content", () => {
    const entries: JsonlEntry[] = [
      { id: "a", parentId: null, kind: "message", message: { role: "user", content: "hi" } },
      { id: "b", parentId: "a", kind: "message", message: { role: "assistant", content: "hello" } },
    ];
    const line = serializeJsonl(entries);
    expect(line.trim().split("\n")).toHaveLength(2);
    expect(parseJsonl(line)).toEqual(entries);
  });

  test("parseJsonl 跳过空行", () => {
    expect(parseJsonl("\n\n")).toEqual([]);
  });
});

describe("T-16 JSONL 会话树", () => {
  test("append 写入以 parentId 链接条目，最新版本成为 leaf", () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "first" });
    tree.append({ role: "assistant", content: "second" });

    expect(tree.entries()).toHaveLength(2);
    expect(tree.entries()[1]?.parentId).toBe(tree.entries()[0]?.id);
    expect(tree.leaf()).toBe(tree.entries()[1]?.id);
    expect(tree.activeBranch().map(contentOf)).toEqual(["first", "second"]);
  });

  test("持久化到磁盘，reopen 恢复树与 leaf", () => {
    const path = tempFile();
    const first = createSessionTree({ path });
    first.append({ role: "user", content: "persisted" });
    const expectedLeaf = first.leaf();

    const reopened = createSessionTree({ path });
    expect(reopened.entries()).toHaveLength(1);
    expect(reopened.leaf()).toBe(expectedLeaf);
    expect(readFileSync(path, "utf8").trim()).toContain("persisted");
  });

  test("fork 从指定 id 创建新分支，不修改原历史条目；leaf 指向新分支", () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "root" });
    const rootId = tree.leaf();
    tree.append({ role: "assistant", content: "original-branch" });
    const originalEntries = [...tree.entries()];

    const forkId = tree.fork(rootId!);
    expect(tree.entries().slice(0, originalEntries.length)).toEqual(originalEntries);
    expect(tree.entries()[originalEntries.length]?.parentId).toBe(rootId);
    expect(tree.leaf()).toBe(forkId);
    expect(contentOf(tree.activeBranch().at(-1)!)).toBeUndefined();
  });

  test("clone 复制整棵树为独立会话，源树不变", () => {
    const sourcePath = tempFile();
    const clonePath = tempFile();
    const source = createSessionTree({ path: sourcePath });
    source.append({ role: "user", content: "clone-me" });
    const snapshot = [...source.entries()];

    const clone = createSessionTree({ path: clonePath }).clone(source.entries());

    expect(source.entries()).toEqual(snapshot);
    expect(clone.entries().map(contentOf)).toEqual(["clone-me"]);
  });

  test("compact 生成 recap 血缘节点，保留父子链与 leaf", () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "old context" });
    tree.append({ role: "assistant", content: "more context" });
    const before = tree.entries().length;

    tree.compact(recap("summary of context"), ["workspace:///block-1"]);

    expect(tree.entries().length).toBe(before + 1);
    const recapEntry = tree.entries().at(-1)!;
    expect(recapEntry.kind).toBe("recap");
    expect(recapEntry.kind === "recap" ? recapEntry.recap.objective : undefined).toBe("summary of context");
    expect(recapEntry.kind === "recap" ? recapEntry.uris : undefined).toEqual(["workspace:///block-1"]);
    expect(tree.leaf()).toBe(recapEntry.id);
    expect(tree.lineage()).toHaveLength(1);
    expect(tree.lineage()[0]?.recap.objective).toBe("summary of context");
  });

  test("branch summary 记录分支血缘，复用 SemanticRecap", () => {
    const tree = createSessionTree({ path: tempFile() });
    tree.append({ role: "user", content: "branch base" });

    tree.summarizeBranch(recap("branch summary"));

    expect(tree.entries().at(-1)?.kind).toBe("recap");
    expect(tree.lineage().at(-1)?.recap.objective).toBe("branch summary");
    expect(tree.activeBranch().at(-1)?.kind).toBe("recap");
  });
});
