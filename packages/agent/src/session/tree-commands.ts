import type { CommandRegistry } from "../commands/registry";
import type { SessionTree } from "./tree";

/** 把 JSONL 会话树接入统一命令注册表的 /session 与 /tree 系列命令。 */
export function registerSessionCommands(
  registry: CommandRegistry,
  tree: SessionTree,
  output: (line: string) => void,
): () => void {
  const stops = [
    registry.register({
      name: "session",
      description: "查看会话信息",
      category: "session",
      handler: () => {
        output(`session: entries=${tree.entries().length} leaf=${tree.leaf() ?? "none"}`);
      },
    }),
    registry.register({
      name: "tree",
      description: "显示会话树活跃分支",
      category: "session",
      handler: () => {
        for (const entry of tree.activeBranch()) {
          if (entry.kind === "message") {
            output(`${entry.id}: ${String(entry.message.content)}`);
          } else {
            output(`${entry.id}: [recap] ${entry.recap.objective}`);
          }
        }
      },
    }),
    registry.register({
      name: "new",
      description: "新建会话分支",
      category: "session",
      handler: () => {
        const leaf = tree.leaf();
        if (leaf !== undefined) tree.fork(leaf);
        output("session: new branch");
      },
    }),
    registry.register({
      name: "fork",
      description: "从当前 leaf 分叉",
      category: "session",
      handler: ({ args }) => {
        const from = args[0] ?? tree.leaf();
        if (from === undefined) {
          output("session: nothing to fork");
          return;
        }
        tree.fork(from);
        output(`session: forked from ${from}`);
      },
    }),
  ];

  return () => {
    for (const stop of stops) stop();
  };
}
